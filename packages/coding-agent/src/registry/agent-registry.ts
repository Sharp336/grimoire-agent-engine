/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/** Sidecar marker retained beside a child transcript after an explicit kill. */
const AGENT_TOMBSTONE_SUFFIX = ".tombstone";

export function getAgentTombstonePath(sessionFile: string): string {
	return `${sessionFile}${AGENT_TOMBSTONE_SUFFIX}`;
}

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/** Provenance of a displayed duration: active runtime, transcript span, or unavailable. */
type AgentDurationKind = "active" | "span" | "unknown";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`hub`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

/** Persisted per-agent totals reconstructed from the child session transcript. */
export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: AgentDurationKind;
	contextTokens?: number;
	contextWindow?: number;
}

/** Historical identity and telemetry that remain available after the live session is disposed. */
export interface AgentHistorySummary {
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	/** Whether the last resolved model was selected by retry fallback routing. */
	resolvedModelIsFallback?: boolean;
	metrics?: AgentMetricsSummary;
	readOnly?: boolean;
	/** Durable task output artifact, when the executor wrote one. */
	outputPath?: string;
	/** Captured isolated-worktree patch, when patch capture succeeded. */
	patchPath?: string;
	/** Isolated branch identity, when branch-mode capture succeeded. */
	branchName?: string;
}

export interface LocalAgentRef {
	/**
	 * Omitted local fields preserve source compatibility with historical
	 * persisted/manual AgentRef fixtures. Registry-created refs always populate
	 * both fields; only remote refs require the discriminant.
	 */
	locality?: "local";
	/** Registry-owned generation, incremented whenever a local id is registered again. */
	generation?: number;
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
}
export interface RegisteredLocalAgentRef extends LocalAgentRef {
	locality: "local";
	generation: number;
}

/** Immutable controller-owned execution identity. It contains no endpoint or capability material. */
export interface RemoteAgentIdentity {
	controllerId: string;
	executionId: string;
	generation: number;
}

export interface RemoteAgentRef {
	readonly locality: "remote";
	/** Controller-owned generation, mirrored for identity checks and roster consumers. */
	readonly generation: number;
	readonly id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	readonly session: null;
	readonly sessionFile: null;
	createdAt: number;
	lastActivity: number;
	activity?: string;
	history?: AgentHistorySummary;
	/** Frozen at registration; backend responses must echo this identity exactly. */
	readonly remote: Readonly<RemoteAgentIdentity>;
}

export type AgentRef = LocalAgentRef | RemoteAgentRef;

export type AgentRefExpectation = AgentRef | AgentSession;

export interface RemoteAgentProgress {
	sequence: number;
	message?: string;
}

export interface RemoteAgentResult {
	outcome: "completed" | "failed" | "cancelled";
	output?: unknown;
	error?: string;
}

export interface RemoteRegistryResponse<T> {
	identity: RemoteAgentIdentity;
	value: T;
}

/**
 * Trusted controller adapter. Endpoint and authority state belong in this
 * closure; none of it is accepted from refs, settings, prompts, or payloads.
 */
export interface RemoteRegistryBackend {
	status(identity: Readonly<RemoteAgentIdentity>, signal?: AbortSignal): Promise<RemoteRegistryResponse<AgentStatus>>;
	progress(
		identity: Readonly<RemoteAgentIdentity>,
		signal?: AbortSignal,
	): Promise<RemoteRegistryResponse<RemoteAgentProgress>>;
	cancel(identity: Readonly<RemoteAgentIdentity>, signal?: AbortSignal): Promise<RemoteRegistryResponse<"cancelled">>;
	result(
		identity: Readonly<RemoteAgentIdentity>,
		signal?: AbortSignal,
	): Promise<RemoteRegistryResponse<RemoteAgentResult>>;
}

export interface RemoteRegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	identity: RemoteAgentIdentity;
	createdAt?: number;
	lastActivity?: number;
	activity?: string;
	history?: AgentHistorySummary;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	/** Last persisted task summary, when restoring a historical agent. */
	activity?: string;
	/** Original registration timestamp, when known from persisted history. */
	createdAt?: number;
	/** Last transcript activity timestamp, when known from persisted history. */
	lastActivity?: number;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}
	/** Install the trusted controller closure used by the process-global registry. */
	static installGlobalRemoteBackend(backend: RemoteRegistryBackend): void {
		const registry = AgentRegistry.global();
		if (registry.#remoteBackend === backend) return;
		if (registry.#remoteBackend) throw new Error("The global remote agent backend is already installed.");
		registry.#remoteBackend = backend;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();
	readonly #localGenerations = new Map<string, number>();
	readonly #remoteProgress = new Map<string, RemoteAgentProgress>();
	readonly #remoteIdentityOwners = new Map<string, string>();
	#remoteBackend: RemoteRegistryBackend | undefined;

	constructor(options?: { remoteBackend?: RemoteRegistryBackend }) {
		this.#remoteBackend = options?.remoteBackend;
	}

	static #validIdentity(identity: unknown): identity is RemoteAgentIdentity {
		if (!identity || typeof identity !== "object") return false;
		const candidate = identity as Partial<RemoteAgentIdentity>;
		return (
			typeof candidate.controllerId === "string" &&
			candidate.controllerId.length > 0 &&
			candidate.controllerId.length <= 256 &&
			candidate.controllerId === candidate.controllerId.trim() &&
			typeof candidate.executionId === "string" &&
			candidate.executionId.length > 0 &&
			candidate.executionId.length <= 256 &&
			candidate.executionId === candidate.executionId.trim() &&
			Number.isSafeInteger(candidate.generation) &&
			(candidate.generation ?? 0) > 0
		);
	}
	static #sameIdentity(left: Readonly<RemoteAgentIdentity>, right: RemoteAgentIdentity): boolean {
		return (
			left.controllerId === right.controllerId &&
			left.executionId === right.executionId &&
			left.generation === right.generation
		);
	}
	static #identityKey(identity: Readonly<RemoteAgentIdentity>): string {
		return `${identity.controllerId.length}:${identity.controllerId}${identity.executionId.length}:${identity.executionId}:${identity.generation}`;
	}

	#remoteRef(id: string): RemoteAgentRef {
		const ref = this.#refs.get(id);
		if (!ref) throw new Error(`Unknown remote agent "${id}".`);
		if (ref.locality !== "remote") throw new Error(`Agent "${id}" is local, not remote.`);
		return ref;
	}

	async #remoteCall<T>(
		id: string,
		operation: keyof RemoteRegistryBackend,
		signal?: AbortSignal,
	): Promise<{ ref: RemoteAgentRef; value: T }> {
		const ref = this.#remoteRef(id);
		const backend = this.#remoteBackend;
		if (!backend) throw new Error(`Remote agent backend is unavailable for "${id}".`);
		let response: RemoteRegistryResponse<T>;
		try {
			const call = backend[operation] as (
				identity: Readonly<RemoteAgentIdentity>,
				callSignal?: AbortSignal,
			) => Promise<RemoteRegistryResponse<T>>;
			response = await call.call(backend, ref.remote, signal);
		} catch (error) {
			throw new Error(
				`Remote agent ${operation} failed for "${id}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		signal?.throwIfAborted();
		if (
			!response ||
			typeof response !== "object" ||
			!AgentRegistry.#validIdentity(response.identity) ||
			!AgentRegistry.#sameIdentity(ref.remote, response.identity)
		) {
			throw new Error(`Remote agent ${operation} returned a stale or malformed identity for "${id}".`);
		}
		if (this.#refs.get(id) !== ref) {
			throw new Error(`Remote agent "${id}" changed generation during ${operation}.`);
		}
		return { ref, value: response.value };
	}

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	#rejectStatusUpdate(id: string, status: AgentStatus, reason: string): false {
		logger.debug("Agent registry status update rejected", { id, status, reason });
		return false;
	}

	register(input: RegisterInput): RegisteredLocalAgentRef {
		const existing = this.#refs.get(input.id);
		if (existing?.locality === "remote") {
			throw new Error(`Cannot register local agent "${input.id}" over a remote execution.`);
		}
		const now = Date.now();
		const generation = (this.#localGenerations.get(input.id) ?? 0) + 1;
		this.#localGenerations.set(input.id, generation);
		const ref: RegisteredLocalAgentRef = {
			locality: "local",
			generation,
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: input.activity,
			history: input.history,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/** Register a controller-owned execution without creating any local session or revival state. */
	registerRemote(input: RemoteRegisterInput): RemoteAgentRef {
		if (!AgentRegistry.#validIdentity(input.identity)) {
			throw new Error(`Remote agent "${input.id}" has an invalid controller identity.`);
		}
		if (input.id.length === 0 || input.id !== input.id.trim()) {
			throw new Error("Remote agent id must be a non-empty normalized string.");
		}
		if (this.#refs.has(input.id)) {
			throw new Error(`Agent "${input.id}" is already registered; local and remote executions cannot overlap.`);
		}
		const identityKey = AgentRegistry.#identityKey(input.identity);
		const identityOwner = this.#remoteIdentityOwners.get(identityKey);
		if (identityOwner) {
			throw new Error(`Remote execution identity is already registered as agent "${identityOwner}".`);
		}
		const now = Date.now();
		const remote = Object.freeze({ ...input.identity });
		const ref: RemoteAgentRef = {
			locality: "remote",
			generation: remote.generation,
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status,
			session: null,
			sessionFile: null,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: input.activity ? oneLineLabel(input.activity) : undefined,
			history: input.history,
			remote,
		};
		Object.defineProperties(ref, {
			id: { value: input.id, enumerable: true, writable: false, configurable: false },
			locality: { value: "remote", enumerable: true, writable: false, configurable: false },
			generation: { value: remote.generation, enumerable: true, writable: false, configurable: false },
			remote: { value: remote, enumerable: true, writable: false, configurable: false },
			session: { value: null, enumerable: true, writable: false, configurable: false },
			sessionFile: { value: null, enumerable: true, writable: false, configurable: false },
		});
		this.#remoteIdentityOwners.set(identityKey, ref.id);
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/** Refresh controller-owned status and progress, rejecting stale generations and malformed state. */
	async refreshRemote(id: string, signal?: AbortSignal): Promise<RemoteAgentRef> {
		const statusResponse = await this.#remoteCall<AgentStatus>(id, "status", signal);
		const status = statusResponse.value;
		if (!["running", "idle", "parked", "aborted"].includes(status)) {
			throw new Error(`Remote agent status returned a malformed value for "${id}".`);
		}
		const progressResponse = await this.#remoteCall<RemoteAgentProgress>(id, "progress", signal);
		const progress = progressResponse.value;
		if (
			!progress ||
			typeof progress !== "object" ||
			!Number.isSafeInteger(progress.sequence) ||
			progress.sequence < 0 ||
			(progress.message !== undefined && typeof progress.message !== "string")
		) {
			throw new Error(`Remote agent progress returned a malformed value for "${id}".`);
		}
		const identityKey = AgentRegistry.#identityKey(progressResponse.ref.remote);
		const priorProgress = this.#remoteProgress.get(identityKey);
		if (priorProgress && progress.sequence < priorProgress.sequence) {
			throw new Error(`Remote agent progress returned a stale sequence for "${id}".`);
		}
		if (priorProgress && progress.sequence === priorProgress.sequence && progress.message !== priorProgress.message) {
			throw new Error(`Remote agent progress returned a conflicting duplicate sequence for "${id}".`);
		}
		const ref = progressResponse.ref;
		if (statusResponse.ref !== ref) throw new Error(`Remote agent "${id}" changed generation during refresh.`);
		this.#remoteProgress.set(identityKey, { sequence: progress.sequence, message: progress.message });
		this.#applyRemoteStatus(ref, status);
		if (progress.message !== undefined && status === "running") ref.activity = oneLineLabel(progress.message);
		ref.lastActivity = Date.now();
		this.#emit({ type: "metadata_changed", ref });
		return ref;
	}

	/** Route cancellation to the controller. Missing/rejecting backends never fall back to local session control. */
	async cancelRemote(id: string, signal?: AbortSignal): Promise<void> {
		const { ref, value } = await this.#remoteCall<"cancelled">(id, "cancel", signal);
		if (value !== "cancelled") throw new Error(`Remote agent cancel returned a malformed result for "${id}".`);
		this.#applyRemoteStatus(ref, "aborted");
	}

	/** Read the controller's terminal result without executing or reviving anything locally. */
	async resultRemote(id: string, signal?: AbortSignal): Promise<RemoteAgentResult> {
		const { value } = await this.#remoteCall<RemoteAgentResult>(id, "result", signal);
		if (
			!value ||
			typeof value !== "object" ||
			!["completed", "failed", "cancelled"].includes(value.outcome) ||
			(value.error !== undefined && typeof value.error !== "string") ||
			(value.outcome === "completed" && value.error !== undefined) ||
			(value.outcome === "failed" && !value.error)
		) {
			throw new Error(`Remote agent result returned a malformed value for "${id}".`);
		}
		return value;
	}

	#applyRemoteStatus(ref: RemoteAgentRef, status: AgentStatus): void {
		if (ref.status === "aborted" && status !== "aborted") {
			throw new Error(`Remote agent "${ref.id}" is aborted and cannot be revived.`);
		}
		if (ref.status === status) return;
		ref.status = status;
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	/**
	 * Register a new id only when it is absent, or reuse the exact detached
	 * `parked` ref a revival was authorized to revive. A missing, replaced, or
	 * terminal expected ref is a failed CAS: delayed revivers must never claim an
	 * id after its prior generation disappeared or was hard-killed.
	 */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): LocalAgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.locality !== "remote" && current.status === "parked" && !current.session
			? current
			: undefined;
	}

	/** Attach transcript-derived identity and telemetry without changing lifecycle state. */
	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref = this.#refs.get(id);
		if (!ref || (expectedSessionFile !== undefined && ref.sessionFile !== expectedSessionFile)) return false;
		const definedHistory = Object.fromEntries(
			Object.entries(history).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (ref.locality === "remote") return this.#rejectStatusUpdate(id, status, "remote-status-is-controller-owned");
		if (!this.#matchesExpected(ref, expected)) {
			return this.#rejectStatusUpdate(id, status, "session-ownership-changed");
		}
		// `aborted` is terminal: delayed progress/revival work from the killed
		// generation must never transition the tombstone back to a live status.
		if (ref.status === "aborted") {
			return status === "aborted" || this.#rejectStatusUpdate(id, status, "aborted-is-terminal");
		}
		if (ref.status === status) return true;
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.locality === "remote") return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		// Remote executions never accept local sessions, including from delayed
		// revivers racing a controller registration.
		if (!ref || ref.locality === "remote" || ref.status === "aborted" || !this.#matchesExpected(ref, expected))
			return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || ref.locality === "remote" || !this.#matchesExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		if (ref.locality === "remote") {
			const identityKey = AgentRegistry.#identityKey(ref.remote);
			this.#remoteProgress.delete(identityKey);
			if (this.#remoteIdentityOwners.get(identityKey) === ref.id) this.#remoteIdentityOwners.delete(identityKey);
		}
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every alive agent (running | idle) except the caller. Advisor refs
	 * are observability-only transcripts, never peers, so they are excluded.
	 * Flat namespace: every other agent is visible.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => ref.id !== id && ref.kind !== "advisor" && (ref.status === "running" || ref.status === "idle"),
		);
	}

	/** Whether a running claim is corroborated by its owning runtime. */
	isRunning(ref: AgentRef): boolean {
		if (ref.status !== "running") return false;
		return ref.locality === "remote" || ref.session?.isStreaming === true;
	}

	/** Mirror a session's authoritative run-state notifications into its owned registry ref. */
	syncSessionStatus(id: string, session: AgentSession): () => void {
		const unsubscribe = session.subscribeRunState(status => {
			this.setStatus(id, status, session);
		});
		return unsubscribe;
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
