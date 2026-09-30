import type {
	CandidateIdentity,
	EngineBindingSnapshot,
	EngineEvent,
	EngineInboxItem,
	EngineSemanticBindingSnapshot,
	ExecutorChoice,
} from "./contracts";
import type { RuntimeIdentityRow } from "./runtime-projection";
import type { EngineAttemptRecord, EngineCommandIdentity, EngineCommandReceipt, EngineEffectRow } from "./store";

export interface RocksIdentity extends RuntimeIdentityRow {
	created_at: number;
	updated_at: number;
}
export interface RocksBinding {
	binding_snapshot?: EngineBindingSnapshot["bindingSnapshot"];
	agent_instance_id: string;
	binding_id: string;
	command_id: string;
	execution_id: string;
	attempt_id: string;
	engine_agent_id: string;
	session_file: string | null;
	execution_schema: 2;
	execution_digest: string;
	continuation_digest: string;
	dispatch_ref: string;
	dispatch_hash: string;
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
	created_at: number;
	result_payload: Record<string, unknown> | null;
	detail_revision: number;
	input_revision: number;
	message_revision: number;
	tool_revision: number;
	transcript_native?: { familyId: string; generationId: string; throughSeq: number; incarnation: number };
	/** Admitted immutable execution provenance; executor_choice.execution_digest is the current projection. */
	execution?: {
		execution_schema: 2;
		execution_digest: string;
		continuation_digest: string;
		dispatch_ref: string;
		dispatch_hash: string;
		executor_choice: ExecutorChoice;
		lease_id: string | null;
		queue_id: string | null;
	};
	executor_route_state: string | null;
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
	binding_pending?: boolean;
	/** Last routing transition of this Attempt start command, committed with the slot rows. */
	routing?: RoutingReceipt;
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
	attachment_descriptors?: EngineInboxItem["attachmentDescriptors"];
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
export type RocksEvent = EngineEvent & {
	event_id: number;
	agent_instance_id: string;
	attempt_id: string;
	published_at: number | null;
	projection?: unknown[];
};

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
		bindingSnapshot: row.binding_snapshot,
		agentInstanceId: row.agent_instance_id,
		executionId: row.execution_id,
		attemptId: row.attempt_id,
		bindingId: row.binding_id,
		commandId: row.command_id,
		engineAgentId: row.engine_agent_id,
		sessionFile: row.session_file ?? undefined,
		executionDigest: row.execution_digest,
		continuationDigest: row.continuation_digest,
		dispatchRef: row.dispatch_ref,
		dispatchHash: row.dispatch_hash,
		state: row.state,
		engineGeneration: row.engine_generation,
		bindingGeneration: row.binding_generation,
		authorityGeneration: row.authority_generation,
		manualHold: Boolean(row.manual_hold),
		intentRevision: row.intent_revision,
		...(row.intent_command_id ? { intentCommandId: row.intent_command_id } : {}),
	};
}

export interface SlotResources {
	scope_refs: string[];
	tier: number | null;
	account_ref: string;
	provider_id: string;
	consultation: boolean;
}
export interface RocksSlotLease {
	schema: "grimoire.slot_lease.v1";
	subtype: "slot_lease";
	principal_id: string;
	device_id: string;
	attempt_id: string;
	lease_revision: number;
	engine_generation: number;
	dispatch_hash: string;
	binding_snapshot_hash: string;
	resources: SlotResources;
	acquired_at: number;
	heartbeat_at: number;
	expires_at: number;
}
export interface RocksWaitEdge {
	subtype: "wait_edge";
	caller_attempt_id: string;
	waited_admission_id: string;
	kind: "child" | "consultation";
}
export interface RocksSlotQueue {
	schema: "grimoire.slot_queue.v1";
	subtype: "slot_queue";
	principal_id: string;
	device_id: string;
	sequence: number;
	/** Always the callee Attempt id, so wait edges survive queue acceptance. */
	admission_id: string;
	command_id: string;
	attempt_id: string;
	dispatch_ref: string;
	dispatch_hash: string;
	origin_receipt_id: string;
	bindingSnapshot: EngineSemanticBindingSnapshot;
	auth_context_id: string;
	roster_revision: `sha256:${string}`;
	candidate_refs: string[];
	requested_at: number;
	reason: string;
	expected_revisions: Record<string, number>;
	status: "waiting" | "admitting" | "accepted" | "cancelled" | "refused";
}
export interface RoutingState {
	subtype: "routing_state";
	principal_id: string;
	device_id: string;
	routing_revision: number;
}
export interface RoutingReceipt {
	action: "acquire" | "renew" | "release" | "transfer" | "enqueue" | "cancel" | "dequeue";
	attempt_id: string;
	receipt_id: string;
	receipt_hash: string;
	lease_id: string | null;
	queue_id: string | null;
	candidate: CandidateIdentity | null;
	lease_revision: number | null;
}
