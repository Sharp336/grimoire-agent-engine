export type ChatGptWebErrorClass =
	| "aborted"
	| "browser_unavailable"
	| "login_required"
	| "profile_conflict"
	| "selector_drift"
	| "tool_protocol"
	| "runtime_draining"
	| "malformed_browser_output"
	| "unsupported_context"
	| "internal";

export type ChatGptWebEvent =
	| { type: "start"; responseId: string }
	| { type: "reasoning"; text: string; continuation?: boolean }
	| { type: "commentary"; text: string; continuation?: boolean }
	| { type: "text"; text: string; continuation?: boolean }
	| { type: "tool_call"; callId: string; name: string; argumentsJson: string; freeform: boolean }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number }
	| { type: "done"; reason: "stop" | "toolUse" | "length" }
	| { type: "error"; errorClass: ChatGptWebErrorClass; retryable: boolean };

export interface ChatGptWebTurnIdentity {
	sessionId: string;
	turnId: string;
}

export interface ChatGptWebRuntimeAdmission {
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
	readonly __opaque: unique symbol;
}

export interface ChatGptWebRuntimeReference {
	readonly __opaque: unique symbol;
}

export type ChatGptWebRuntimeAdmissionOwner =
	| "turn"
	| "tunnel"
	| "browser-lease"
	| "broker-binding"
	| "tunnel-process"
	| "connector";

export interface ChatGptWebRuntimeGate {
	/** Under one lifecycle lock/CAS, validate running state and register the initial reservation. */
	admit(kind: "turn" | "tunnel"): Promise<ChatGptWebRuntimeAdmission>;
	/** Under the same lock, add one uniquely releasable reference to an existing reservation. */
	retain(
		admission: ChatGptWebRuntimeAdmission,
		owner: Exclude<ChatGptWebRuntimeAdmissionOwner, "turn" | "tunnel">,
	): ChatGptWebRuntimeReference;
	/** Idempotently drop exactly this admission/reference; clones and already-released handles fail closed. */
	release(handle: ChatGptWebRuntimeAdmission | ChatGptWebRuntimeReference): void;
	/** Close admission, invalidate the epoch, and wait/cancel all registered reservations. */
	drain(): Promise<void>;
	/** Start a fresh epoch/generation after drain; old handles remain invalid forever. */
	resume(): Promise<{ runtimeEpoch: string; lifecycleGeneration: number }>;
}
