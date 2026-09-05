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
	agentInstanceId: string;
	/** Canonical hosted identity used for child AgentInstance creation. */
	agentInstanceRef?: string;
	/** Presentation-only name. Identity and routing stay agentInstanceId/ref. */
	displayName?: string;
	/** Evidence-backed future delegation hint; never routing authority. */
	delegationHint?: string;
	parentAgentInstanceId?: string;
	executionId: string;
	attemptId: string;
	authorityGeneration: number;
	cwd: string;
	input: string;
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
	message: string;
}

export interface EngineCancelRequest extends EngineTarget {
	commandId: string;
	reason?: string;
}

export type EngineControlInitiator =
	| { kind: "human" }
	| { kind: "agent"; agentInstanceId: string; agentInstanceRef: string };

export interface EngineControlRequest extends EngineTarget {
	commandId: string;
	initiator: EngineControlInitiator;
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
}

export interface EngineStartResult extends EngineBindingSnapshot {
	duplicate: boolean;
}

export interface EngineReconcileResult {
	binding?: EngineBindingSnapshot;
	attemptState?: EngineAttemptState;
}

export interface EngineCompletionPayload extends Record<string, unknown> {
	assistantFinal: string;
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
		| "provider_attempt_started"
		| "provider_attempt_settled"
		| "provider_retry_scheduled"
		| "provider_retry_finished"
		| "provider_route_changed"
		| "provider_route_served"
		| "inbox_changed"
		| "trace_reasoning"
		| "trace_tool";
	payload?: Record<string, unknown>;
	createdAt: number;
}

export class EngineTargetError extends Error {
	constructor(
		readonly code: "agent_not_found" | "agent_busy" | "stale_target" | "too_late" | "invalid_request",
		message: string,
	) {
		super(message);
		this.name = "EngineTargetError";
	}
}

export function validateStartRequest(request: EngineStartRequest): void {
	for (const [name, value] of Object.entries({
		commandId: request.commandId,
		agentInstanceId: request.agentInstanceId,
		executionId: request.executionId,
		attemptId: request.attemptId,
		cwd: request.cwd,
		input: request.input,
	})) {
		if (!value.trim()) {
			throw new EngineTargetError("invalid_request", `${name} must be a non-empty string`);
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
}
