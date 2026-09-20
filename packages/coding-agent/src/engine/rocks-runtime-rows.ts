import type { EngineBindingSnapshot, EngineEvent, EngineInboxItem } from "./contracts";
import type { RuntimeIdentityRow } from "./runtime-projection";
import type { EngineAttemptRecord, EngineCommandIdentity, EngineCommandReceipt, EngineEffectRow } from "./store";

export interface RocksIdentity extends RuntimeIdentityRow {
	created_at: number;
	updated_at: number;
}
export interface RocksBinding {
	agent_instance_id: string;
	binding_id: string;
	command_id: string;
	execution_id: string;
	attempt_id: string;
	engine_agent_id: string;
	session_file: string | null;
	profile_digest: string;
	conversation_identity_digest: string | null;
	state: EngineBindingSnapshot["state"];
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	manual_hold: number;
	intent_revision: number;
	intent_command_id: string | null;
	updated_at: number;
}
export interface RocksAttempt extends EngineAttemptRecord {
	result_payload: Record<string, unknown> | null;
	detail_revision: number;
	input_revision: number;
	message_revision: number;
	tool_revision: number;
	transcript_native?: { familyId: string; generationId: string; throughSeq: number; incarnation: number };
}
export interface RocksCommand {
	command_id: string;
	agent_instance_id: string;
	processor_generation: number | null;
	state: "received" | "settled";
	canonical_hash: string;
	payload_bytes: number;
	control_admission: number;
	engine_generation: number;
	operation: string;
	identity: EngineCommandIdentity;
	receipt: EngineCommandReceipt | null;
	received_at: number;
	updated_at: number;
	pending_accounted: boolean;
	start_applied_intent_revision?: number;
}
export interface RocksEffect extends EngineEffectRow {
	command_id: string;
	created_at: number;
	updated_at: number;
	error?: string | null;
	job_ids?: string[];
	runtime_event_id: number;
}
export interface RocksInbox extends EngineInboxItem {
	subtype: "item";
	queue_id: string;
	source_event_id: string;
	session_id: string;
	agent_instance_id: string;
	execution_id: string;
	attempt_id: string;
	binding_id: string;
	engine_generation: number;
	binding_generation: number;
	authority_generation: number;
	deliver_at: number | null;
	wake_intent: number;
	wake_delivered_at: number | null;
}
export interface RocksHold {
	source_agent_instance_id: string;
	kind: "pause" | "stop" | "recovery";
	command_id: string;
	generation: number;
}
export interface RocksEvent extends EngineEvent {
	event_id: number;
	agent_instance_id: string;
	attempt_id: string;
	published_at: number | null;
	projection?: unknown[];
}

export function bindingTarget(binding: EngineBindingSnapshot) {
	return {
		agent_instance_id: binding.agentInstanceId,
		execution_id: binding.executionId,
		attempt_id: binding.attemptId,
		binding_id: binding.bindingId,
		engine_generation: binding.engineGeneration,
		binding_generation: binding.bindingGeneration,
		authority_generation: binding.authorityGeneration,
	};
}
export function bindingSnapshot(row: RocksBinding): EngineBindingSnapshot {
	return {
		agentInstanceId: row.agent_instance_id,
		executionId: row.execution_id,
		attemptId: row.attempt_id,
		bindingId: row.binding_id,
		commandId: row.command_id,
		engineAgentId: row.engine_agent_id,
		sessionFile: row.session_file ?? undefined,
		profileDigest: row.profile_digest,
		state: row.state,
		engineGeneration: row.engine_generation,
		bindingGeneration: row.binding_generation,
		authorityGeneration: row.authority_generation,
		manualHold: Boolean(row.manual_hold),
		intentRevision: row.intent_revision,
		...(row.intent_command_id ? { intentCommandId: row.intent_command_id } : {}),
	};
}
