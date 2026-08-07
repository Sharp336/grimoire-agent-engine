import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSessionEvent } from "./agent-session-events";
import type {
	SessionAuthority,
	SessionAuthorityObservation,
	SessionAuthorityReplay,
	SessionAuthoritySettlement,
	SessionAuthoritySnapshot,
	SessionCommand,
	SessionCommandContext,
	SessionCommandOutcome,
	SessionJournalCursor,
	SessionJsonValue,
} from "./session-host";
import { MAX_SESSION_IDEMPOTENCY_KEYS, SessionCursorError } from "./session-host";

interface AgentSessionAuthorityEntry {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
}

export interface AgentSessionAuthoritySource {
	readonly sessionManager: {
		getSessionId(): string;
		getLeafId(): string | null | undefined;
		getBranch(): readonly AgentSessionAuthorityEntry[];
	};
	subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void;
	waitForSessionMessagePersistence(message: unknown): Promise<void>;
}

export interface AgentSessionAuthorityOptions {
	snapshotState(): Promise<SessionJsonValue>;
	invoke(command: SessionCommand, context: SessionCommandContext): Promise<SessionCommandOutcome>;
	settle(): Promise<SessionAuthoritySettlement>;
}

interface IdempotentCommandEntry {
	command: SessionCommand;
	outcome: Promise<SessionCommandOutcome>;
}

/**
 * Adapts AgentSession's ordered event stream and SessionManager's journal into
 * one observation boundary. Agent events remain transient; newly committed
 * journal entries become stable durable observations only after persistence.
 */
export class AgentSessionAuthority implements SessionAuthority {
	readonly #session: AgentSessionAuthoritySource;
	readonly #options: AgentSessionAuthorityOptions;
	readonly #listeners = new Set<(observation: SessionAuthorityObservation) => void>();
	readonly #knownEntryIds: Set<string>;
	readonly #causation = new AsyncLocalStorage<string>();
	readonly #idempotentCommands = new Map<string, IdempotentCommandEntry>();
	readonly #unsubscribe: () => void;
	#eventTail: Promise<void> = Promise.resolve();
	#sourceGeneration = 0;
	#revision: number;
	#settling = false;
	#settlementPromise: Promise<SessionAuthoritySettlement> | undefined;
	#disposed = false;

	constructor(session: AgentSessionAuthoritySource, options: AgentSessionAuthorityOptions) {
		this.#session = session;
		this.#options = options;
		const branch = session.sessionManager.getBranch();
		this.#knownEntryIds = new Set(branch.map(entry => entry.id));
		this.#revision = branch.length;
		this.#unsubscribe = session.subscribe(event => {
			this.#sourceGeneration++;
			const causationId = this.#causation.getStore();
			this.#eventTail = this.#eventTail.then(() => this.#handleEvent(event, causationId));
		});
	}

	get sessionId(): string {
		return this.#session.sessionManager.getSessionId();
	}

	async snapshot(captureWatermark: () => void): Promise<SessionAuthoritySnapshot> {
		while (true) {
			await this.#eventTail;
			const sourceGeneration = this.#sourceGeneration;
			const state = await this.#options.snapshotState();
			await this.#eventTail;
			if (sourceGeneration !== this.#sourceGeneration) continue;
			const snapshot = {
				revision: this.#revision,
				state,
				journalCursor: this.#journalCursor(),
			};
			captureWatermark();
			return snapshot;
		}
	}

	subscribe(listener: (observation: SessionAuthorityObservation) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#listeners.clear();
	}
	async replay(after: SessionJournalCursor, limit: number): Promise<SessionAuthorityReplay> {
		const branch = this.#session.sessionManager.getBranch();
		if (after.sessionId !== this.sessionId) {
			throw new SessionCursorError("stale_cursor", "Durable cursor belongs to a different session");
		}
		const leafIndex = after.leafId === null ? -1 : branch.findIndex(entry => entry.id === after.leafId);
		const entryIndex = after.entryId === null ? -1 : branch.findIndex(entry => entry.id === after.entryId);
		if (
			(after.leafId === null) !== (after.entryId === null) ||
			leafIndex < entryIndex ||
			(after.leafId !== null && leafIndex < 0) ||
			(after.entryId !== null && entryIndex < 0)
		) {
			throw new SessionCursorError("stale_cursor", "Durable cursor is not on the active session branch");
		}
		const entries = branch.slice(entryIndex + 1);
		if (entries.length > limit) {
			throw new SessionCursorError(
				"replay_limit_exceeded",
				`Durable replay contains ${entries.length} entries, exceeding the limit of ${limit}`,
			);
		}
		return {
			observations: entries.map(entry => ({
				durability: "durable",
				eventId: `${this.sessionId}:${entry.id}`,
				journalCursor: {
					sessionId: this.sessionId,
					leafId: entry.id,
					entryId: entry.id,
				},
				kind: "journal_entry",
				payload: entry as unknown as SessionJsonValue,
				terminalSettlement: "none",
			})),
			journalCursor: this.#journalCursor(),
		};
	}

	invoke(command: SessionCommand, context: SessionCommandContext): Promise<SessionCommandOutcome> {
		const key = command.idempotencyKey;
		if (key === undefined) return this.#invokeCommand(command, context);
		const existing = this.#idempotentCommands.get(key);
		if (existing) {
			if (Bun.deepEquals(existing.command, command)) return existing.outcome;
			return Promise.resolve({
				outcome: "failed",
				error: {
					code: "idempotency_conflict",
					message: `Idempotency key ${key} was already used for a different command`,
					retryable: false,
				},
			});
		}
		if (this.#idempotentCommands.size >= MAX_SESSION_IDEMPOTENCY_KEYS) {
			return Promise.resolve({
				outcome: "failed",
				error: {
					code: "idempotency_capacity",
					message: `Session retains at most ${MAX_SESSION_IDEMPOTENCY_KEYS} idempotency keys`,
					retryable: false,
				},
			});
		}
		const outcome = this.#invokeCommand(command, context);
		this.#idempotentCommands.set(key, { command: structuredClone(command), outcome });
		return outcome;
	}

	async #invokeCommand(command: SessionCommand, context: SessionCommandContext): Promise<SessionCommandOutcome> {
		if (this.#settling) {
			return {
				outcome: "failed",
				error: { code: "session_closing", message: "Session authority is settling", retryable: false },
			};
		}
		if (command.expectedRevision !== undefined && command.expectedRevision !== this.#revision) {
			return {
				outcome: "failed",
				revision: this.#revision,
				error: {
					code: "revision_conflict",
					message: `Expected revision ${command.expectedRevision}, current revision is ${this.#revision}`,
					retryable: true,
				},
			};
		}
		const outcome = await this.#causation.run(context.requestId, () => this.#options.invoke(command, context));
		await this.#eventTail;
		this.#emitNewJournalEntries(context.requestId);
		return { ...outcome, revision: this.#revision };
	}

	settle(): Promise<SessionAuthoritySettlement> {
		if (this.#settlementPromise) return this.#settlementPromise;
		this.#settling = true;
		this.#settlementPromise = (async () => {
			const settlement = await this.#options.settle();
			await this.#eventTail;
			this.#emitNewJournalEntries();
			this.#emit({
				durability: "transient",
				kind: "session_settled",
				payload: {
					revision: this.#revision,
					journalCursor: this.#journalCursor(),
				},
				terminalSettlement: "completed",
			});
			this.dispose();
			return settlement;
		})();
		return this.#settlementPromise;
	}

	async #handleEvent(event: AgentSessionEvent, causationId: string | undefined): Promise<void> {
		this.#emit({
			durability: "transient",
			...(causationId === undefined ? {} : { causationId }),
			kind: event.type,
			payload: event as unknown as SessionJsonValue,
			terminalSettlement: event.type === "agent_end" ? "completed" : "none",
		});
		if (event.type !== "message_end") return;
		await this.#session.waitForSessionMessagePersistence(event.message);
		this.#emitNewJournalEntries(causationId);
	}

	#emitNewJournalEntries(causationId?: string): void {
		const branch = this.#session.sessionManager.getBranch();
		for (const entry of branch) {
			if (this.#knownEntryIds.has(entry.id)) continue;
			this.#knownEntryIds.add(entry.id);
			this.#revision++;
			this.#emit({
				...(causationId === undefined ? {} : { causationId }),
				durability: "durable",
				eventId: `${this.sessionId}:${entry.id}`,
				journalCursor: {
					sessionId: this.sessionId,
					leafId: entry.id,
					entryId: entry.id,
				},
				kind: "journal_entry",
				payload: entry as unknown as SessionJsonValue,
				terminalSettlement: "none",
			});
		}
	}

	#journalCursor() {
		return {
			sessionId: this.sessionId,
			leafId: this.#session.sessionManager.getLeafId() ?? null,
			entryId: this.#session.sessionManager.getLeafId() ?? null,
		};
	}

	#emit(observation: SessionAuthorityObservation): void {
		for (const listener of this.#listeners) {
			try {
				listener(observation);
			} catch {
				// Subscriber failure is isolated from AgentSession's authority stream.
			}
		}
	}
}
