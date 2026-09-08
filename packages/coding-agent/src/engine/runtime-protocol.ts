import { EngineTargetError } from "./contracts";
import {
	canonicalRuntimeJson,
	RuntimeProtocolError,
	validateRuntimeValue as validateSharedRuntimeValue,
} from "./runtime-protocol.mjs";
import protocol from "./runtime-protocol-v1.json" with { type: "json" };

export const RUNTIME_PROTOCOL_HASH = "sha256:16bc6acaf985473b3f5ad5af14dbe302bc962a27b69221a0d0313be1a1909b7a";
export const runtimeLimits = protocol["x-artel"].limits;
export const ENGINE_CONTROL_OPS = new Set(["pause", "resume", "cancel", "resolve_input", "resolve_tool_approval"]);

export type RuntimeDetailKind = "assistant" | "tool" | "state" | "queue" | "input" | "history" | "usage";
export type RuntimeDetailInterest =
	| { kind: "agent"; agentInstanceRef: string; kinds: RuntimeDetailKind[] }
	| { kind: "attempt"; agentInstanceRef: string; attemptId: string; kinds: RuntimeDetailKind[] };
export type RuntimeScope =
	| { kind: "catalog" }
	| { kind: "branch"; rootAgentInstanceRef: string; interests: RuntimeDetailInterest[] }
	| RuntimeDetailInterest;

export interface RuntimeAccess {
	principalId: string;
	authorizedAgentInstanceRefs?: string[];
}

export interface RuntimeWork {
	bytes: number;
	changes: number;
	scannedRows: number;
	materializedBytes: number;
	elapsedMs: number;
}

export interface RuntimeRemainingWork {
	bytes: number;
	changes: number;
	scannedRows: number;
	materializedBytes: number;
	timeMs: number;
}

export interface RuntimeEventsRequest extends RuntimeAccess {
	scope: RuntimeScope;
	epoch: string;
	afterCursor: number;
	untilCursor?: number;
	timeoutMs: number;
	limit: number;
	maxBytes: number;
	remainingWork: RuntimeRemainingWork;
}

export interface RuntimeChange {
	kind: "summary" | "membership" | "state" | "assistant" | "tool" | "history" | "invalidate" | "receipt";
	agentInstanceRef: string;
	attemptId?: string;
	revision: number;
	cursor: number;
	value: Record<string, unknown>;
}

export interface RuntimeEventBatch {
	epoch: string;
	throughCursor: number;
	headCursor: number;
	changes: RuntimeChange[];
	hasMore: boolean;
	work: RuntimeWork;
}

export function runtimeProjectionHash(scope: RuntimeScope): string {
	return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalRuntimeJson(scope)).digest("hex")}`;
}

export function validateRuntimeValue(name: string, value: unknown): void {
	try {
		validateSharedRuntimeValue(name, value);
	} catch (error) {
		if (error instanceof RuntimeProtocolError) {
			throw new EngineTargetError(
				error.code === "payload_too_large" ? "payload_too_large" : "invalid_request",
				error.message,
			);
		}
		throw error;
	}
}

export function runtimeRemainingWork(): RuntimeRemainingWork {
	return {
		bytes: runtimeLimits.replayBytes,
		changes: runtimeLimits.replayChanges,
		scannedRows: runtimeLimits.replayScannedRows,
		materializedBytes: runtimeLimits.replayMaterializedBytes,
		timeMs: runtimeLimits.replayTimeoutMs,
	};
}
