import type { SessionDurabilityCheckpoint } from "../session/session-manager";
import type {
	EngineAttemptState,
	EngineBindingSnapshot,
	EngineEvent,
	EngineRetryOutcome,
	EngineToolPolicy,
} from "./contracts";
import type { RuntimeScope } from "./runtime-protocol";

export interface EngineAttemptRow {
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	command_id: string;
	binding_id: string;
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	state: EngineAttemptState;
	transcript_session_id: string | null;
	transcript_path: string | null;
	transcript_leaf_entry_id: string | null;
	transcript_byte_boundary: number | null;
	transcript_revision: number;
	retry_attempt: number;
	retry_max_attempts: number;
	retry_route: string | null;
	retry_delay_ms: number | null;
	retry_scheduled_at: number | null;
	retry_outcome: EngineRetryOutcome | null;
	retry_error: string | null;
	profile_route_state: string | null;
}

export interface EngineAttemptRecord extends EngineAttemptRow {
	row_id: number;
	cause: string | null;
	updated_at: number;
}

export type EngineAttemptTargetRecord = Pick<
	EngineAttemptRecord,
	| "agent_instance_id"
	| "execution_id"
	| "attempt_id"
	| "binding_id"
	| "engine_generation"
	| "binding_generation"
	| "authority_generation"
	| "state"
>;

export interface ExpiredChildHistory {
	agentInstanceId: string;
	agentInstanceRef: string;
	attemptId: string;
	sessionFile: string;
	terminalAt: number;
}

export interface RetainedDirectChildHistory {
	agentInstanceId: string;
	agentInstanceRef: string;
	engineAgentId: string;
	sessionFile: string;
}

export interface EngineCommandIdentity {
	commandId: string;
	operation: string;
	deviceId: string;
	engineId: string;
	engineGeneration: number;
	agentInstanceId: string;
	agentInstanceRef?: string;
	parentAgentInstanceId?: string;
	parentAgentInstanceRef?: string;
	bindingId?: string;
	bindingGeneration?: number;
	executionId?: string;
	attemptId?: string;
	authorityGeneration: number;
	payloadHash: string;
	canonicalHash: string;
	principalId?: string;
	browserPayloadHash?: string;
	serializedCommand?: string;
}

export interface EngineBranchHold {
	sourceAgentInstanceId: string;
	sourceAgentInstanceRef: string;
	commandId: string;
	generation: number;
	kind: "pause" | "stop" | "recovery";
}

export interface EngineRuntimeSnapshot {
	version: "1.0";
	scope: RuntimeScope;
	epoch: string;
	generation: number;
	watermark: number;
	agents: Record<string, unknown>[];
	nextCursor: string | null;
}

export interface EngineRuntimeEvents {
	epoch: string;
	generation: number;
	throughCursor: number;
	events: EngineEvent[];
	resyncRequired: boolean;
	reason?: "epoch_changed" | "retention_gap" | "projection_changed";
	hasMore: boolean;
}

export type EngineStartConversationIdentity = Pick<
	EngineCommandIdentity,
	| "operation"
	| "agentInstanceId"
	| "agentInstanceRef"
	| "parentAgentInstanceId"
	| "authorityGeneration"
	| "serializedCommand"
>;

export interface EngineCommandReceipt {
	outcome: "applied" | "rejected";
	detail?: Record<string, unknown>;
}

export interface EnginePendingStartCancellation {
	status: "cancelled" | "already_cancelled" | "too_late" | "not_found";
	event?: EngineEvent;
	intentRevision?: number;
}

export interface EngineTransitionEvent {
	kind: EngineEvent["kind"];
	payload?: Record<string, unknown>;
	causationCommandId?: string;
}

export interface EngineTranscriptCheckpoint extends SessionDurabilityCheckpoint {
	revision: number;
}

export interface EngineToolEffectInput {
	effectId: string;
	toolCallId: string;
	toolName: string;
	policy: EngineToolPolicy;
	inputHash: string;
	origin?: { messageId: string; blockId: string };
}

export interface EngineModelEffectInput {
	effectId: string;
	modelCallId: string;
	inputHash: string;
}

export interface EngineEffectRow {
	effect_id: string;
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	binding_id: string;
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	tool_call_id: string;
	tool_name: string;
	assistant_message_id: string | null;
	assistant_block_id: string | null;
	policy: EngineToolPolicy;
	input_hash: string;
	effect_kind: "tool" | "model";
	state: "planned" | "started" | "settled" | "unknown";
	outcome: "completed" | "failed" | "cancelled" | "denied" | "unknown" | null;
}

export interface EngineApprovalRow {
	approval_id: string;
	effect_id: string;
	state: "pending" | "resolved";
	decision: "approve" | "deny" | "cancelled" | null;
}

export type EngineCommandAdmission =
	| { status: "claimed" }
	| { status: "in_progress" }
	| { status: "replay"; receipt: EngineCommandReceipt };

export class EngineCommandConflictError extends Error {
	constructor(commandId: string) {
		super(`Command ${commandId} was already admitted with different canonical content`);
		this.name = "EngineCommandConflictError";
	}
}

export class EngineAttemptConflictError extends Error {
	constructor(attemptId: string) {
		super(`Attempt ${attemptId} is already bound to another runtime identity`);
		this.name = "EngineAttemptConflictError";
	}
}

export class EngineEffectConflictError extends Error {
	constructor(effectId: string) {
		super(`Tool effect ${effectId} is not in the expected durable state`);
		this.name = "EngineEffectConflictError";
	}
}

export class EngineInboxConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineInboxConflictError";
	}
}

export interface EngineHistoryArchive {
	schema: "grimoire.engine.history_archive_journal.v1";
	operationId: string;
	state: "retiring" | "retired" | "restoring" | "restored";
	binding: EngineBindingSnapshot & { sessionFile: string };
	sessionId: string;
	contentHash: string;
	nativeBytes: number;
	archivePath: string;
	archiveHash: string;
	archiveBytes: number;
}
