import { isRecord } from "@oh-my-pi/pi-utils";
import type { ExtensionAskDialogResult } from "../extensibility/extensions/types";
import { engineRouteToken } from "./route";
import { validateRuntimeValue } from "./runtime-protocol";
import type {
	ApprovalAddressee, ApprovalDecider, ApprovalDecision, ApprovalRequest, ChoiceTransition,
	EngineExecutionConfiguration, ExecutorChoice, StartSpecialRef,
} from "./runtime-protocol.mjs";
export type {
	Effort, ServiceTier, WorkTarget, WorkStep, TaskHead, AgentHead, RequestedExecution,
	DispatchRequest, DispatchDerivedPromptRequest, DispatchBranchRequest,
	Dispatch, DispatchSpawn, DispatchRequirement, DispatchLimits, SpecialRef,
	CandidateIdentity, Candidate, SelectedExecutor, ChoiceTransition, ExecutorChoice,
	BillingPool, QuotaWindow, Price, ExecutorGlobalSettings, DispatchPreset,
	UserProvider, ProviderAccount, UserModel, AvailableModelRoute, ScopeLimits, Rule, Consultant,
	ApprovalRequest, ApprovalDecision, ApprovalDecisionInput, ApprovalAddressee, ApprovalDecider,
	ToolApprovalSubject, SpawnApprovalSubject, EscalationApprovalSubject, ConsultantApprovalSubject,
	EngineExecutionConfiguration, EngineExecutionRoutes, EngineExecutionRoute, ExecutionDescriptor,
	ExecutorRouteState as EngineExecutorRouteState, ImmutableAttemptStart, EngineCommandPayload,
	ContinuationConfiguration, ContinuationDigestInput, ExecutionDigestInput, RoutingLimits,
	NativeCompatibility, RosterRequest, ExecutorSettingsRequest, AutomationExecution,
} from "./runtime-protocol.mjs";

/** Immutable semantic scope admitted by Core/ClientHost, independent of transport generations. */
export interface EngineSemanticBindingSnapshot {
	agentInstanceRef: string;
	taskRef: string | null;
	workStepId: string | null;
	bindingRevision: number;
	installationId: string | null;
	parentAgentInstanceRef: string | null;
	parentAttemptId: string | null;
	parentBindingRevision: number | null;
}

export function sameSemanticBinding(
	left: EngineSemanticBindingSnapshot | undefined,
	right: EngineSemanticBindingSnapshot | undefined,
): boolean {
	return Boolean(left && right &&
		left.agentInstanceRef === right.agentInstanceRef &&
		left.taskRef === right.taskRef && left.workStepId === right.workStepId &&
		left.bindingRevision === right.bindingRevision && left.installationId === right.installationId);
}

export function validateSemanticBinding(snapshot: EngineSemanticBindingSnapshot, agentInstanceRef: string): void {
	validateRuntimeValue("bindingSnapshot", snapshot);
	if (snapshot.agentInstanceRef !== agentInstanceRef)
		throw new EngineTargetError("invalid_request", "Binding snapshot belongs to another Agent");
	if (snapshot.installationId === null) {
		if (agentInstanceRef.startsWith("grimoire://agents/") || !snapshot.taskRef ||
			snapshot.taskRef.startsWith("grimoire://tasks/~u/"))
			throw new EngineTargetError("invalid_request", "Legacy execution requires its immutable project binding");
	} else if (!agentInstanceRef.startsWith("grimoire://agents/~u/")) {
		throw new EngineTargetError("invalid_request", "Owned execution requires an owner-scoped Agent");
	}
}

/** Binding waits are transport retry, never a terminal command rejection. */
export class EngineBindingPendingError extends Error {
	readonly code = "binding_pending";
	constructor(message = "Installation verification or binding activation is pending") {
		super(message);
	}
}

/** A capacity-queued Start remains received until its exact command can acquire a lease. */
export class EngineRoutingQueuedError extends Error {
	readonly code = "routing_queued";
	constructor(readonly queueId: string) {
		super(`Start is waiting for routing capacity in ${queueId}`);
	}
}

export interface EngineBindingGate {
	bindingSnapshot: EngineSemanticBindingSnapshot;
	phase: "open" | "preparing" | "committed_closed";
	operationId: string | null;
	proposalHash: string | null;
	gateRevision: number;
	censusMutationRevision: number;
	committedTarget?: EngineSemanticBindingSnapshot;
}

export interface EngineBindingOperationResult {
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

export interface EngineBindingResult extends EngineBindingOperationResult {
	schema: "grimoire.agent_binding.result.v1";
	action: "prepare" | "status" | "commit" | "abort" | "adopt";
	operation_result: EngineBindingOperationResult;
}

export interface EngineBindingCheckpoint {
	agent_ref: string;
	installation_id: string;
	operation_id: string;
	proposal_hash: string;
	binding_revision: number;
	gate_revision: number;
	census_mutation_revision: number;
	runtime_contract_revision: 17;
	engine_generation: number;
	status: "complete" | "busy" | "unknown";
	nonterminal_starts: number;
	nonterminal_attempts: number;
	open_effects: number;
	unsettled_children: number;
	mutable_pending_writes: number;
	next_cursor: string | null;
}

/** Resolve pre-S0 child birth from immutable parent scope and retained delegation, never URI scope. */
export function legacyLocalChildBirth(
	command: { agentInstanceRef?: string; parentAgentInstanceRef?: string; payload: Record<string, unknown> },
	parent: EngineSemanticBindingSnapshot,
): { agentInstanceId: string; bindingSnapshot: EngineSemanticBindingSnapshot } {
	validateSemanticBinding(parent, command.parentAgentInstanceRef ?? "");
	if (parent.installationId !== null)
		throw new EngineTargetError("source_unavailable", "Owned child birth requires its frozen snapshot");
	const child = command.payload.localChild;
	if (!isRecord(child) || typeof child.parentAttemptId !== "string" || !child.parentAttemptId ||
		typeof child.toolCallId !== "string" || !child.toolCallId ||
		(child.workStepId != null && typeof child.workStepId !== "string"))
		throw new EngineTargetError("source_unavailable", "Legacy child birth provenance is unavailable");
	const seed = [parent.agentInstanceRef, child.parentAttemptId, child.toolCallId].join("\0");
	const agentInstanceId = `agent_${engineRouteToken(seed)}`;
	const agentInstanceRef = `${parent.taskRef}/agents/${agentInstanceId}`;
	if (command.agentInstanceRef !== agentInstanceRef)
		throw new EngineTargetError("stale_target", "Legacy child identity differs from its admitted birth");
	const bindingSnapshot: EngineSemanticBindingSnapshot = {
		agentInstanceRef,
		taskRef: parent.taskRef,
		workStepId: child.workStepId ?? null,
		bindingRevision: 0,
		installationId: null,
		parentAgentInstanceRef: parent.agentInstanceRef,
		parentAttemptId: child.parentAttemptId,
		parentBindingRevision: 0,
	};
	validateSemanticBinding(bindingSnapshot, agentInstanceRef);
	return { agentInstanceId, bindingSnapshot };
}

export type EngineAttemptState =
	| "accepted"
	| "running"
	| "pause_requested"
	| "paused"
	| "waiting_input"
	| "cancel_requested"
	| "completed"
	| "cancelled"
	| "failed"
	| "interrupted";
export type EngineBindingState = "idle" | "running" | "released";
export type EngineToolPolicy = "unrestricted" | "tracked" | "permit";
export type EngineRetryOutcome = "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface EngineRetryState {
	attempt: number;
	maxAttempts: number;
	route?: string;
	delayMs?: number;
	scheduledAt?: number;
	outcome?: EngineRetryOutcome;
	error?: string;
}

export const MAX_ENGINE_CHILD_ASSIGNMENT_BYTES = 32 * 1024;

export interface EngineStartRequest {
	commandId: string;
	/** Ready uploads owned by principalId and bound to clientMessageId. */
	attachmentUploadIds?: string[];
	/** Opaque UI identity for the exact user message introduced by this command. */
	clientMessageId?: string;
	/** Complete authorized pre-admission roster; selection is made atomically by Engine. */
	executionConfiguration: EngineExecutionConfiguration;
	dispatchRef: string;
	dispatchHash: string;
	executionKind: "ordinary" | "automation" | "consultation";
	specialRef: StartSpecialRef | null;
	originReceiptId: string;
	agentInstanceId: string;
	/** Canonical hosted identity used for child AgentInstance creation. */
	agentInstanceRef: string;
	bindingSnapshot: EngineSemanticBindingSnapshot;
	/** Presentation-only name. Identity and routing stay agentInstanceId/ref. */
	displayName?: string;
	/** Evidence-backed future delegation hint; never routing authority. */
	delegationHint?: string;
	parentAgentInstanceId?: string;
	parentAgentInstanceRef?: string;
	executionId: string;
	attemptId: string;
	authorityGeneration: number;
	cwd: string;
	input?: string;
	/**
	 * Native history operation applied only when this Start is admitted. Branch
	 * keeps the selected entry unchanged; edit replaces it while preserving its
	 * canonical user/assistant role. The source is fenced independently because
	 * a branch starts a distinct destination AgentInstance.
	 */
	historyEdit?: EngineHistoryEditSource;
	/** Immutable caller context for this command, separate from the user/inbox body. */
	context?: string;
	/**
	 * Hash-pinned native checkpoint previously staged for this exact hosted
	 * AgentInstance authority. It is forked into a fresh native session only
	 * when this explicit Start is admitted.
	 */
	restoreCheckpoint?: EngineRestoreCheckpointSource;
	/** Durable inbox identity for an automatic queued start. Mutually exclusive with input. */
	queueId?: string;
	expectedRevision?: number;
	mutationId?: string;
	/** Required to clear a durable manual hold for an explicit user send. */
	expectedIntentRevision?: number;
	explicitContinue?: boolean;
	principalId: string;
}

export interface EngineRestoreCheckpointSource {
	restoreId: string;
	contentHash: string;
}

export interface EngineHistoryEditSource {
	expectedSourceIntentRevision?: number;
	mode: "edit" | "branch";
	source: EngineTarget;
	sourceSessionId: string;
	expectedLeafEntryId: string;
	entryId: string;
	/** Required only for edit; branch never rewrites the selected message. */
	replacementText?: string;
}

export interface EngineTarget {
	bindingId: string;
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	authorityGeneration: number;
	engineGeneration: number;
	bindingGeneration: number;
}

export interface EngineSteerRequest extends EngineTarget {
	commandId: string;
	principalId?: string;
	attachmentUploadIds?: string[];
	context?: string;
	/** Opaque UI identity for the exact user message introduced by this command. */
	clientMessageId?: string;
	message?: string;
	queueId?: string;
	expectedRevision?: number;
	mutationId?: string;
	expectedIntentRevision?: number;
}

export interface EngineCancelRequest extends EngineTarget {
	commandId: string;
	reason?: string;
	expectedIntentRevision?: number;
	pendingStartCommandId?: string;
	expectedStartIntentRevision?: number;
	principalId?: string;
}

export type EngineControlInitiator =
	| { kind: "human" }
	| { kind: "agent"; agentInstanceId: string; agentInstanceRef: string };

export interface EngineControlRequest extends EngineTarget {
	commandId: string;
	/** Resume-only user message; context remains separate non-user instructions. */
	message?: string;
	clientMessageId?: string;
	attachmentUploadIds?: string[];
	principalId?: string;
	/** Optional context delivered when resuming the admitted Attempt. */
	context?: string;
	initiator: EngineControlInitiator;
	expectedIntentRevision?: number;
}

export interface EngineApprovalDecision extends EngineTarget {
	expectedIntentRevision?: number;
	expectedInputRevision?: number;
	commandId: string;
	approvalDecision: ApprovalDecision;
}

export interface EngineIndexedInputResult {
	kind: "submit";
	results: Array<{ id: string; selectedOptionIndexes: number[]; customInput?: string; note?: string }>;
}

export interface EngineResolveInputRequest extends EngineTarget {
	expectedIntentRevision?: number;
	expectedInputRevision?: number;
	commandId: string;
	inputId: string;
	result: ExtensionAskDialogResult | EngineIndexedInputResult;
}

export interface EngineReconcileRequest {
	commandId: string;
	agentInstanceId: string;
	authorityGeneration: number;
}

export interface EnginePeerMessage {
	messageId: string;
	fromAgentInstanceId: string;
	toAgentInstanceId: string;
	body: string;
	sentAt?: number;
	replyToMessageId?: string;
}

export type EngineInboxSourceType = "user" | "agent" | "runtime";
export type EngineInboxDisposition = "pending" | "acknowledged" | "dropped";

export interface EngineInboxTarget extends EngineTarget {
	sessionId: string;
}

/** Immutable upload references; principal is supplied by the authenticated command adapter. */
export interface EngineMessageAttachments {
	principalId: string;
	uploadIds: string[];
}

export interface EngineAttachmentDescriptor {
	uploadId: string;
	clientMessageId: string;
	name: string;
	mediaType: string;
	bytes: number;
	contentHash: string;
}

export interface EngineInboxSource {
	sourceEventId: string;
	sourceType: EngineInboxSourceType;
	sender?: string;
	body: string;
	attachments?: EngineMessageAttachments;
	createdAt?: number;
	deliverAt?: number;
	wakeIntent?: boolean;
}

export interface EngineInboxItem {
	queueId: string;
	sessionId: string;
	agentInstanceId: string;
	attemptId: string;
	sourceEventId: string;
	sourceType: EngineInboxSourceType;
	sender?: string;
	sourceBody: string;
	attachments?: EngineMessageAttachments;
	attachmentDescriptors?: EngineAttachmentDescriptor[];
	deliveryPayload: string;
	annotation?: string;
	deliverAt?: number;
	wakeIntent: boolean;
	wakeDeliveredAt?: number;
	position: number;
	disposition: EngineInboxDisposition;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface EngineInboxMutation {
	mutationId: string;
	queueId: string;
	expectedRevision: number;
	op: "edit" | "annotate" | "defer" | "acknowledge" | "drop";
	value?: string | number | null;
}

export interface EngineBindingSnapshot extends EngineTarget {
	bindingSnapshot?: EngineSemanticBindingSnapshot;
	commandId: string;
	engineAgentId: string;
	sessionFile?: string;
	executionDigest: string;
	continuationDigest: string;
	dispatchRef: string;
	dispatchHash: string;
	state: EngineBindingState;
	manualHold?: boolean;
	intentRevision?: number;
	intentCommandId?: string;
}

export interface EngineStartResult extends EngineBindingSnapshot {
	duplicate: boolean;
	queueId?: string;
	queueRevision?: number;
	historyEdit?: EngineHistoryEditResult;
	executorChoice?: ExecutorChoice;
}

export interface EngineHistoryEditResult {
	mode: "edit" | "branch";
	sourceSessionId: string;
	sourceEntryId: string;
	replacementEntryId?: string;
	sessionId: string;
}

export interface EngineControlResult extends Record<string, unknown> {
	phase: "applied" | "consumed";
	manualHold: boolean;
	intentRevision: number;
	alreadyTerminal?: true;
	queueId?: string;
	queueRevision?: number;
	sourceEventId?: string;
}

export interface EngineReconcileResult {
	binding?: EngineBindingSnapshot;
	attemptState?: EngineAttemptState;
}

export interface EngineCompletionPayload extends Record<string, unknown> {
	assistantFinal: string;
	assistantMessageId?: string;
	transcriptRef?: string;
	outputTruncated?: boolean;
}

export interface EngineRejectedCommand {
	commandId: string;
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	authorityGeneration: number;
	bindingGeneration?: number;
	code: EngineTargetError["code"];
	message: string;
	operation?: "start";
}

export interface EngineEventBase {
	agentInstanceRef?: string;
	bindingSnapshot?: EngineSemanticBindingSnapshot;
	eventId: number;
	seq: number;
	causationCommandId: string;
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	engineGeneration: number;
	bindingId: string;
	bindingGeneration: number;
	authorityGeneration: number;
	createdAt: number;
}

export interface EngineOrdinaryEvent extends EngineEventBase {
	kind:
		| "agent_registered"
		| "holds_changed"
		| "command_receipt"
		| "cancel_requested"
		| "accepted"
		| "rejected"
		| "running"
		| "pause_requested"
		| "paused"
		| "resumed"
		| "completed"
		| "cancelled"
		| "failed"
		| "interrupted"
		| "reconciled"
		| "steered"
		| "input_requested"
		| "input_resolved"
		| "tool_started"
		| "tool_settled"
		| "model_started"
		| "model_settled"
		| "retry_scheduled"
		| "retry_settled"
		| "queued"
		| "waiting_children"
		| "inbox_changed"
		| "assistant_snapshot"
		| "history_checkpoint"
		| "message_updated"
		| "trace_reasoning"
		| "trace_tool";
	payload?: Record<string, unknown>;
}

export interface EngineApprovalEventPayloads {
	tool_approval_requested: ApprovalRequest;
	spawn_approval_requested: ApprovalRequest;
	escalation_approval_requested: ApprovalRequest;
	consultant_approval_requested: ApprovalRequest;
	tool_approval_resolved: EngineApprovalResolved;
	spawn_approval_resolved: EngineApprovalResolved;
	escalation_approval_resolved: EngineApprovalResolved;
	consultant_approval_resolved: EngineApprovalResolved;
	approval_escalated: {
		request_id: string; address_revision: number;
		from: ApprovalAddressee;
		to: ApprovalAddressee;
		expires_at: string | null;
	};
	approval_timed_out: { request_id: string; address_revision: number; status: "pending" | "waiting_human_paused" };
	executor_route_changed: ChoiceTransition;
}
export type EngineApprovalResolved = {
	request_id: string;
	decision_revision: number;
} & (
	| { outcome: "approved" | "denied"; decided_by: ApprovalDecider }
	| { outcome: "cancelled"; decided_by: ApprovalDecider | null }
);
export type EngineEvent = EngineOrdinaryEvent | {
	[Kind in keyof EngineApprovalEventPayloads]: EngineEventBase & {
		kind: Kind; payload: EngineApprovalEventPayloads[Kind];
	}
}[keyof EngineApprovalEventPayloads];

export class EngineTargetError extends Error {
	constructor(
		readonly code:
			| "agent_not_found"
			| "agent_busy"
			| "admission_dependency_cycle"
			| "capacity_unavailable"
			| "admission_state_unknown"
			| "queue_full"
			| "payload_too_large"
			| "retention_gap"
			| "epoch_changed"
			| "projection_changed"
			| "restore_budget"
			| "source_unavailable"
			| "interrupted"
			| "stale_target"
			| "too_late"
			| "invalid_request"
			| "history_expired"
			| "launch_failed"
			| "attachment_requires_read"
			| "attachment_expired"
			| "attachment_requires_images"
			| "command_failed"
			| "message_accepted_resume_unknown"
			| "cancelled",
		message: string,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "EngineTargetError";
	}
}

export function validateStartRequest(request: EngineStartRequest): void {
	validateCommandContext(request.context);
	validateSemanticBinding(request.bindingSnapshot, request.agentInstanceRef);
	validateRuntimeValue("engineExecutionConfiguration", request.executionConfiguration);
	validateRuntimeValue("artifactRef", request.dispatchRef);
	validateRuntimeValue("hash", request.dispatchHash);
	validateRuntimeValue("id", request.originReceiptId);
	const dispatch = request.executionConfiguration.dispatch;
	if (request.executionKind !== dispatch.execution_kind ||
		(request.specialRef === null) !== (dispatch.special_ref === null) ||
		(dispatch.target !== null && (dispatch.target.task_ref !== request.bindingSnapshot.taskRef ||
			dispatch.target.work_step_id !== request.bindingSnapshot.workStepId)))
		throw new EngineTargetError("invalid_request", "Start differs from its admitted dispatch or binding");
	if (dispatch.special_ref && (!request.specialRef ||
		request.specialRef.definitionRef !== dispatch.special_ref.definition_ref ||
		request.specialRef.revision !== dispatch.special_ref.definition_revision ||
		request.specialRef.occurrenceOrCallId !== ("occurrence_id" in dispatch.special_ref
			? dispatch.special_ref.occurrence_id : dispatch.special_ref.call_id)))
		throw new EngineTargetError("invalid_request", "Start special identity differs from its dispatch");
	for (const [name, value] of Object.entries({
		commandId: request.commandId,
		agentInstanceId: request.agentInstanceId,
		executionId: request.executionId,
		attemptId: request.attemptId,
		cwd: request.cwd,
	})) {
		if (!value.trim()) {
			throw new EngineTargetError("invalid_request", `${name} must be a non-empty string`);
		}
	}
	const queued = request.queueId !== undefined;
	const historyEdit = request.historyEdit;
	const restoreCheckpoint = request.restoreCheckpoint;
	if (request.attachmentUploadIds !== undefined && (queued || historyEdit || restoreCheckpoint))
		throw new EngineTargetError("invalid_request", "Explicit attachments require an ordinary message start");
	if (
		queued
			? !request.queueId?.trim() ||
				!request.mutationId?.trim() ||
				!Number.isSafeInteger(request.expectedRevision) ||
				request.expectedRevision! < 0 ||
				!Number.isSafeInteger(request.expectedIntentRevision) ||
				request.expectedIntentRevision! < 0 ||
				request.input !== undefined ||
				historyEdit !== undefined ||
				restoreCheckpoint !== undefined
			: historyEdit
				? request.mutationId !== undefined ||
					request.expectedRevision !== undefined ||
					(request.input !== undefined && !request.input.trim())
				: (!request.input?.trim() && !request.explicitContinue && !request.attachmentUploadIds?.length) ||
					request.mutationId !== undefined ||
					request.expectedRevision !== undefined
	) {
		throw new EngineTargetError("invalid_request", "start requires text or a complete queued-item identity");
	}
	if (restoreCheckpoint) {
		if (historyEdit || queued) {
			throw new EngineTargetError("invalid_request", "restoreCheckpoint requires an explicit ordinary start");
		}
		if (!/^[0-9a-f]{64}$/.test(restoreCheckpoint.restoreId)) {
			throw new EngineTargetError("invalid_request", "restoreCheckpoint.restoreId must be a SHA-256 token");
		}
		if (!/^sha256:[0-9a-f]{64}$/.test(restoreCheckpoint.contentHash)) {
			throw new EngineTargetError("invalid_request", "restoreCheckpoint.contentHash must be a SHA-256 digest");
		}
		if (!request.agentInstanceRef?.trim()) {
			throw new EngineTargetError("invalid_request", "restoreCheckpoint requires agentInstanceRef");
		}
	}
	if (historyEdit) {
		if (historyEdit.mode !== "edit" && historyEdit.mode !== "branch") {
			throw new EngineTargetError("invalid_request", "historyEdit.mode must be edit or branch");
		}
		for (const [name, value] of Object.entries({
			sourceSessionId: historyEdit.sourceSessionId,
			expectedLeafEntryId: historyEdit.expectedLeafEntryId,
			entryId: historyEdit.entryId,
			"source.bindingId": historyEdit.source.bindingId,
			"source.agentInstanceId": historyEdit.source.agentInstanceId,
			"source.executionId": historyEdit.source.executionId,
			"source.attemptId": historyEdit.source.attemptId,
		})) {
			if (!value.trim()) throw new EngineTargetError("invalid_request", `historyEdit.${name} must be non-empty`);
		}
		for (const [name, value] of Object.entries({
			"source.authorityGeneration": historyEdit.source.authorityGeneration,
			"source.engineGeneration": historyEdit.source.engineGeneration,
			"source.bindingGeneration": historyEdit.source.bindingGeneration,
		})) {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new EngineTargetError("invalid_request", `historyEdit.${name} must be a non-negative safe integer`);
			}
		}
		if (historyEdit.mode === "edit" && !historyEdit.replacementText?.trim()) {
			throw new EngineTargetError("invalid_request", "history edit requires non-empty replacementText");
		}
	}
	for (const [name, value] of Object.entries({
		agentInstanceRef: request.agentInstanceRef,
		parentAgentInstanceId: request.parentAgentInstanceId,
	})) {
		if (value !== undefined && !value.trim()) {
			throw new EngineTargetError("invalid_request", `${name} must be a non-empty string when supplied`);
		}
	}
	if (
		request.clientMessageId !== undefined &&
		(!request.clientMessageId.trim() || request.clientMessageId.length > 200)
	) {
		throw new EngineTargetError("invalid_request", "clientMessageId must contain 1 to 200 characters when supplied");
	}
	if (
		request.displayName !== undefined &&
		(!request.displayName.trim() || request.displayName.length > 64 || /[\r\n\0]/.test(request.displayName))
	) {
		throw new EngineTargetError("invalid_request", "displayName must be a safe one-line string of 1..64 characters");
	}
	if (
		request.delegationHint !== undefined &&
		(request.delegationHint.length > 200 || /[\r\n\0]/.test(request.delegationHint))
	) {
		throw new EngineTargetError(
			"invalid_request",
			"delegationHint must be a one-line string no larger than 200 characters",
		);
	}
	if (!Number.isSafeInteger(request.authorityGeneration) || request.authorityGeneration < 0) {
		throw new EngineTargetError("invalid_request", "authorityGeneration must be a non-negative safe integer");
	}
	if (
		request.expectedIntentRevision !== undefined &&
		(!Number.isSafeInteger(request.expectedIntentRevision) || request.expectedIntentRevision < 0)
	) {
		throw new EngineTargetError("invalid_request", "expectedIntentRevision must be a non-negative safe integer");
	}
}

export function validateCommandContext(context: unknown): asserts context is string | undefined {
	if (context !== undefined && (typeof context !== "string" || Buffer.byteLength(context, "utf8") > 65_536)) {
		throw new EngineTargetError("invalid_request", "context must be a string of at most 65536 UTF-8 bytes");
	}
}
