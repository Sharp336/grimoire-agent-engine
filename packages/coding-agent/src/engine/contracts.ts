import type { ExtensionAskDialogResult } from "../extensibility/extensions/types";

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

export interface EngineLaunchProfile {
	/** Empty disables nested agents; "*" enables the native OMP spawn surface. */
	spawns: string;
	profileDigest: string;
	/** Exact reopens prior conversation state; fresh always starts a new transcript. */
	continuationPolicy?: "exact" | "fresh";
	launchProfileRef?: string;
	selectedRouteRef?: string;
	/** Descendants allowed below this session. Artel default: one leaf child. */
	maxSpawnDepth?: number;
	/** Total child AgentInstances this Attempt may launch. */
	maxChildren?: number;
	/** Exact child AgentProfiles allowed by the pinned parent AgentProfile. */
	childProfileRefs?: string[];
	/** Per-launch stable instructions; AgentProfile itself intentionally has no permanent prompt. */
	systemPrompt?: string;
	/** Stable provider cache identity compiled by ClientHost for consultant launches. */
	providerPromptCacheKey?: string;
	toolNames?: string[];
	restrictToolNames?: boolean;
	/** Optional per-tool boundary policy. Missing tools remain unrestricted. */
	toolPolicies?: Record<string, EngineToolPolicy>;
	enableMCP?: boolean;
	enableLsp?: boolean;
	/** Per-session LSP transport policy; false keeps a private client. */
	lspShared?: boolean;
	/** Capability providers excluded by the compiled launch policy. */
	disabledCapabilityProviders?: string[];
	/** Existing OMP yield schema used by bounded consultant sessions. */
	outputSchema?: unknown;
	requireYieldTool?: boolean;
}

export interface EngineStartRequest {
	commandId: string;
	/** Opaque UI identity for the exact user message introduced by this command. */
	clientMessageId?: string;
	agentInstanceId: string;
	/** Canonical hosted identity used for child AgentInstance creation. */
	agentInstanceRef?: string;
	parentAgentInstanceId?: string;
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
	/** Durable inbox identity for an automatic queued start. Mutually exclusive with input. */
	queueId?: string;
	expectedRevision?: number;
	mutationId?: string;
	/** Required to clear a durable manual hold for an explicit user send. */
	expectedIntentRevision?: number;
}

export interface EngineHistoryEditSource {
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
}

export type EngineControlInitiator =
	| { kind: "human" }
	| { kind: "agent"; agentInstanceId: string; agentInstanceRef: string };

export interface EngineControlRequest extends EngineTarget {
	commandId: string;
	/** Optional context delivered when resuming the admitted Attempt. */
	context?: string;
	initiator: EngineControlInitiator;
	expectedIntentRevision?: number;
}

export interface EngineToolApprovalDecision extends EngineTarget {
	commandId: string;
	approvalId: string;
	decision: "approve" | "deny";
	reason?: string;
}

export interface EngineResolveInputRequest extends EngineTarget {
	commandId: string;
	inputId: string;
	result: ExtensionAskDialogResult;
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

export interface EngineInboxSource {
	sourceEventId: string;
	sourceType: EngineInboxSourceType;
	sender?: string;
	body: string;
	createdAt: number;
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
	commandId: string;
	engineAgentId: string;
	sessionFile?: string;
	profileDigest: string;
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
}

export interface EngineEvent {
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
	kind:
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
		| "tool_approval_requested"
		| "tool_approval_resolved"
		| "input_requested"
		| "input_resolved"
		| "tool_started"
		| "tool_settled"
		| "model_started"
		| "model_settled"
		| "retry_scheduled"
		| "retry_settled"
		| "inbox_changed"
		| "assistant_snapshot"
		| "trace_reasoning"
		| "trace_tool";
	payload?: Record<string, unknown>;
	createdAt: number;
}

export class EngineTargetError extends Error {
	constructor(
		readonly code:
			| "agent_not_found"
			| "agent_busy"
			| "stale_target"
			| "too_late"
			| "invalid_request"
			| "history_expired"
			| "launch_failed"
			| "cancelled",
		message: string,
	) {
		super(message);
		this.name = "EngineTargetError";
	}
}

export function validateStartRequest(request: EngineStartRequest): void {
	validateCommandContext(request.context);
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
	if (
		queued
			? !request.queueId?.trim() ||
				!request.mutationId?.trim() ||
				!Number.isSafeInteger(request.expectedRevision) ||
				request.expectedRevision! < 0 ||
				!Number.isSafeInteger(request.expectedIntentRevision) ||
				request.expectedIntentRevision! < 0 ||
				request.input !== undefined ||
				historyEdit !== undefined
			: historyEdit
				? request.mutationId !== undefined ||
					request.expectedRevision !== undefined ||
					(request.input !== undefined && !request.input.trim())
				: !request.input?.trim() || request.mutationId !== undefined || request.expectedRevision !== undefined
	) {
		throw new EngineTargetError("invalid_request", "start requires text or a complete queued-item identity");
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
