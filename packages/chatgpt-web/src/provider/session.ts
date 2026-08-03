import { createHash } from "node:crypto";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { ChatGptWebInvocationRequest, ChatGptWebTurnIssue } from "./orchestration";
import type { ChatGptWebPromptMode } from "./prompt";
import type { ChatGptWebEvent, ChatGptWebRuntimeAdmission, ChatGptWebTurnIdentity } from "./types";

export const CHATGPT_WEB_SESSION_KEY_PREFIX = "@oh-my-pi/pi-chatgpt-web:";
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const MAX_RETIRED_CONTINUATIONS_PER_SESSION = 8;
const MAX_RETIRED_CALL_OWNERS = 4096;

interface EventWaiter {
	resolve: (event: ChatGptWebEvent) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class ChatGptWebEventFeed {
	readonly #queue: ChatGptWebEvent[] = [];
	readonly #waiters = new Set<EventWaiter>();
	#closedError?: Error;

	push(event: ChatGptWebEvent): void {
		if (this.#closedError) return;
		const waiter = this.#waiters.values().next().value as EventWaiter | undefined;
		if (!waiter) {
			this.#queue.push(event);
			return;
		}
		this.#waiters.delete(waiter);
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(event);
	}

	close(error: unknown): void {
		if (this.#closedError) return;
		this.#closedError = error instanceof Error ? error : new Error(String(error));
		for (const waiter of this.#waiters) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(this.#closedError);
		}
		this.#waiters.clear();
	}

	next(signal?: AbortSignal): Promise<ChatGptWebEvent> {
		const queued = this.#queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (signal?.aborted) return Promise.reject(new DOMException("ChatGPT Web event wait aborted", "AbortError"));
		const { promise, resolve, reject } = Promise.withResolvers<ChatGptWebEvent>();
		const waiter: EventWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
		if (signal) {
			waiter.onAbort = () => {
				this.#waiters.delete(waiter);
				reject(new DOMException("ChatGPT Web event wait aborted", "AbortError"));
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		this.#waiters.add(waiter);
		return promise;
	}
}

export interface ChatGptWebPendingBatch {
	requests: readonly ChatGptWebInvocationRequest[];
	toolNamesByCallId: Readonly<Record<string, string>>;
	deliveredAt: number;
}

interface RetiredContinuation {
	readonly fingerprint: string;
	readonly callIds: readonly string[];
	readonly expiresAt: number;
}

interface RetiredCallOwner {
	readonly sessionKey: string;
	readonly expiresAt: number;
}
interface ConsumedContinuation {
	readonly fingerprint: string;
	readonly callIds: readonly string[];
}

function continuationToolResultIds(messages: readonly Message[]): readonly string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const callId = (message as ToolResultMessage).toolCallId;
		if (typeof callId !== "string" || callId.length === 0) continue;
		ids.push(callId);
		if (ids.length >= 512) break;
	}
	return ids;
}

export function continuationContextFingerprint(messages: readonly Message[]): string {
	const serialized = JSON.stringify(messages) ?? "";
	return createHash("sha256").update(serialized).digest("hex");
}

export interface ChatGptWebSessionState {
	readonly key: string;
	readonly identity: ChatGptWebTurnIdentity;
	readonly admission: ChatGptWebRuntimeAdmission;
	readonly routeKey: string;
	readonly effort?: string;
	readonly mode: ChatGptWebPromptMode;
	readonly toolSetKey: string;
	readonly requiresPro: boolean;
	readonly feed: ChatGptWebEventFeed;
	readonly abortController: AbortController;
	readonly createdAt: number;
	readonly cleanup: () => void;
	expiresAt: number;
	issue?: ChatGptWebTurnIssue;
	pendingBatch?: ChatGptWebPendingBatch;
	browserOutcome?: Promise<unknown>;
	responseId?: string;
	released: boolean;
	consumedToolResultIds: Set<string>;
	continuationFingerprint?: string;
	consumedContinuationHistory: ConsumedContinuation[];
	tail: Promise<void>;
}

export class ChatGptWebSessionRegistry {
	readonly #entries = new Map<string, ChatGptWebSessionState>();
	readonly #retired = new Map<string, RetiredContinuation[]>();
	readonly #retiredCallOwners = new Map<string, RetiredCallOwner>();

	constructor(
		readonly ttlMs = DEFAULT_SESSION_TTL_MS,
		readonly maxEntries = 256,
	) {}

	key(sessionId: string): string {
		return `${CHATGPT_WEB_SESSION_KEY_PREFIX}${sessionId}`;
	}
	assertContinuationNotRetired(sessionId: string, messages: readonly Message[], now = Date.now()): void {
		const callIds = continuationToolResultIds(messages);
		if (callIds.length === 0) return;
		this.prune(now);
		const key = this.key(sessionId);
		for (const state of this.#entries.values()) {
			if (state.key === key) continue;
			for (const callId of callIds) {
				if (
					state.consumedToolResultIds.has(callId) ||
					state.pendingBatch?.requests.some(request => request.callId === callId)
				) {
					throw new Error(`ChatGPT Web tool result belongs to another active session: ${callId}`);
				}
			}
		}
		for (const callId of callIds) {
			const owner = this.#retiredCallOwners.get(callId);
			if (owner && owner.sessionKey !== key) {
				throw new Error(`ChatGPT Web tool result belongs to another session: ${callId}`);
			}
		}
		const fingerprint = continuationContextFingerprint(messages);
		if (this.#retired.get(key)?.some(entry => entry.fingerprint === fingerprint)) {
			throw new Error("ChatGPT Web tool result continuation was already consumed");
		}
	}

	get(sessionId: string, now = Date.now()): ChatGptWebSessionState | undefined {
		this.prune(now);
		return this.#entries.get(this.key(sessionId));
	}

	create(
		state: Omit<
			ChatGptWebSessionState,
			"key" | "expiresAt" | "released" | "consumedToolResultIds" | "consumedContinuationHistory" | "tail"
		>,
		now = Date.now(),
	): ChatGptWebSessionState {
		this.prune(now);
		const key = this.key(state.identity.sessionId);
		if (this.#entries.has(key)) throw new Error("ChatGPT Web session already has an active browser turn");
		if (this.#entries.size >= this.maxEntries) throw new Error("ChatGPT Web session registry is full");
		const entry: ChatGptWebSessionState = {
			...state,
			key,
			expiresAt: now + this.ttlMs,
			released: false,
			consumedToolResultIds: new Set(),
			consumedContinuationHistory: [],
			tail: Promise.resolve(),
		};
		this.#entries.set(key, entry);
		return entry;
	}

	touch(state: ChatGptWebSessionState, now = Date.now()): void {
		if (this.#entries.get(state.key) !== state || state.released) throw new Error("ChatGPT Web session is stale");
		state.expiresAt = now + this.ttlMs;
	}
	retire(state: ChatGptWebSessionState, now = Date.now()): void {
		const history = [...state.consumedContinuationHistory];
		if (state.continuationFingerprint && state.consumedToolResultIds.size > 0) {
			history.push({
				fingerprint: state.continuationFingerprint,
				callIds: [...state.consumedToolResultIds],
			});
		}
		if (history.length === 0) return;
		const key = state.key;
		const entries = [...(this.#retired.get(key) ?? []), ...history]
			.filter(entry => entry.callIds.length > 0)
			.slice(-MAX_RETIRED_CONTINUATIONS_PER_SESSION)
			.map(entry => ({ ...entry, expiresAt: now + this.ttlMs }));
		this.#retired.set(key, entries);
		for (const entry of entries) {
			for (const callId of entry.callIds) {
				while (this.#retiredCallOwners.size >= MAX_RETIRED_CALL_OWNERS) {
					const oldest = this.#retiredCallOwners.keys().next().value;
					if (oldest === undefined) break;
					this.#retiredCallOwners.delete(oldest);
				}
				this.#retiredCallOwners.set(callId, { sessionKey: key, expiresAt: entry.expiresAt });
			}
		}
	}

	remove(state: ChatGptWebSessionState): void {
		if (!state.released) this.retire(state);
		if (this.#entries.get(state.key) === state) this.#entries.delete(state.key);
		state.released = true;
		state.abortController.abort();
	}

	runExclusive<T>(state: ChatGptWebSessionState, task: () => Promise<T>): Promise<T> {
		const run = state.tail.then(task);
		state.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	clear(): void {
		for (const state of this.#entries.values()) {
			this.retire(state);
			state.released = true;
			state.abortController.abort();
			state.cleanup();
		}
		this.#entries.clear();
		this.#retired.clear();
		this.#retiredCallOwners.clear();
	}

	private prune(now: number): void {
		for (const [key, state] of this.#entries) {
			if (state.expiresAt > now) continue;
			this.retire(state, now);
			state.released = true;
			state.abortController.abort();
			state.cleanup();
			this.#entries.delete(key);
		}
		for (const [key, entries] of this.#retired) {
			const live = entries.filter(entry => entry.expiresAt > now);
			if (live.length === 0) this.#retired.delete(key);
			else this.#retired.set(key, live);
		}
		for (const [callId, owner] of this.#retiredCallOwners) {
			if (owner.expiresAt <= now) this.#retiredCallOwners.delete(callId);
		}
	}
}

export const providerSessionState = new ChatGptWebSessionRegistry();

export function consumeContinuationResults(
	state: ChatGptWebSessionState,
	messages: readonly Message[],
): readonly { callId: string; result: ToolResultMessage }[] | undefined {
	const batch = state.pendingBatch;
	if (!batch) return undefined;
	const expected = new Set(batch.requests.map(request => request.callId));
	const matching: ToolResultMessage[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		if (!expected.has(result.toolCallId)) continue;
		if (state.consumedToolResultIds.has(result.toolCallId)) {
			throw new Error(`ChatGPT Web tool result was already consumed: ${result.toolCallId}`);
		}
		if (matching.some(current => current.toolCallId === result.toolCallId)) {
			throw new Error(`ChatGPT Web received a duplicate tool result: ${result.toolCallId}`);
		}
		matching.push(result);
	}
	if (matching.length === 0) return undefined;
	if (matching.length !== expected.size) {
		throw new Error(`ChatGPT Web received ${matching.length} of ${expected.size} results for the pending tool batch`);
	}
	for (const result of matching) {
		if (result.toolName !== batch.toolNamesByCallId[result.toolCallId]) {
			throw new Error(`ChatGPT Web tool result does not match pending call ${result.toolCallId}`);
		}
	}
	return matching.map(result => ({ callId: result.toolCallId, result }));
}

export function markContinuationConsumed(
	state: ChatGptWebSessionState,
	results: readonly { callId: string; result: ToolResultMessage }[],
): void {
	if (!state.pendingBatch || results.length !== state.pendingBatch.requests.length) {
		throw new Error("ChatGPT Web cannot consume a different tool result batch");
	}
	for (const result of results) state.consumedToolResultIds.add(result.callId);
	if (state.continuationFingerprint) {
		if (state.consumedContinuationHistory.length >= MAX_RETIRED_CONTINUATIONS_PER_SESSION) {
			state.consumedContinuationHistory.shift();
		}
		state.consumedContinuationHistory.push({
			fingerprint: state.continuationFingerprint,
			callIds: results.map(result => result.callId),
		});
		state.continuationFingerprint = undefined;
	}
	state.pendingBatch = undefined;
}
