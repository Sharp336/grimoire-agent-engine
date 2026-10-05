import { perfTimed } from "@oh-my-pi/pi-utils/perf-trace";
import { type EngineSemanticBindingSnapshot, EngineTargetError } from "./contracts";
import {
	canonicalRuntimeJson,
	RuntimeProtocolError,
	validateRuntimeValue as validateSharedRuntimeValue,
} from "./runtime-protocol.mjs";
import protocol from "./runtime-protocol-v1.json" with { type: "json" };

export const RUNTIME_PROTOCOL_HASH = "sha256:28f855799b18e654b951f859f1d7882a5ca28556946b71606f910ae74cf3119e";
export { RUNTIME_PROTOCOL_REVISION } from "./runtime-protocol.mjs";
export const runtimeOriginIdChars = protocol.$defs.id.maxLength;
export const runtimeLimits = protocol["x-artel"].limits;
export const runtimeToolPageRecords = protocol.$defs.toolsPage.properties.items.maxItems;
export const runtimeToolIdChars = protocol.$defs.toolCallId.maxLength;
export const runtimeToolNameChars = protocol.$defs.toolDetail.properties.name.maxLength;
export const ENGINE_CONTROL_OPS: Readonly<Record<string, true>> = {
	pause: true, resume: true, cancel: true, resolve_input: true, resolve_approval: true,
};

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

/** Current binding shapes; revision17 is required at the managed boundary. */
export interface RuntimeBindingGate {
	bindingSnapshot: EngineSemanticBindingSnapshot;
	phase: "open" | "preparing" | "committed_closed";
	operationId: string | null;
	proposalHash: string | null;
	gateRevision: number;
	censusMutationRevision: number;
	committedTarget?: EngineSemanticBindingSnapshot;
}

export interface RuntimeBindingCheckpoint {
	agent_ref: string;
	installation_id: string;
	operation_id: string;
	proposal_hash: string;
	binding_revision: number;
	gate_revision: number;
	census_mutation_revision: number;
	runtime_contract_revision: 17;
	runtime_contract_hash: string;
	engine_generation?: number;
	status: "complete" | "busy" | "unknown";
	nonterminal_starts: number;
	nonterminal_attempts: number;
	open_effects: number;
	unsettled_children: number;
	mutable_pending_writes: number;
	next_cursor: string | null;
}

export interface RuntimeBindingIdleReceipt {
	schema: "grimoire.agent_binding.idle.v1";
	agent_ref: string;
	installation_id: string;
	operation_id: string;
	proposal_hash: string;
	binding_revision: number;
	ch_checkpoint: RuntimeBindingCheckpoint;
	engine_checkpoint: RuntimeBindingCheckpoint;
}

export interface RuntimeBindingOperationResult {
	agent_ref: string;
	revision: number;
	binding_revision: number;
	task_ref: string | null;
	work_step_id: string | null;
	installation_id: string;
	phase: "active" | "preparing" | "committed_await_adopt";
	operation_id: string;
	proposal_hash: string;
	status: "prepared" | "committed" | "adopted" | "aborted" | "unchanged";
}

export type RuntimeBindingResult =
	| { schema: "grimoire.agent_binding.result.v1"; action: "register_installation"; status: "registered"; installation_id: string }
	| (RuntimeBindingOperationResult & {
		schema: "grimoire.agent_binding.result.v1";
		action: "prepare" | "status" | "commit" | "abort" | "adopt";
		operation_result: RuntimeBindingOperationResult;
	});

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
		perfTimed("engine.validate", name, undefined, () => validateSharedRuntimeValue(name, value));
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
