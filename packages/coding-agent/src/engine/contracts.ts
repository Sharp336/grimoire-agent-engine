export type EngineAttemptState =
	| "accepted"
	| "running"
	| "cancel_requested"
	| "completed"
	| "cancelled"
	| "failed"
	| "interrupted";
export type EngineBindingState = "idle" | "running" | "released";

export interface EngineLaunchProfile {
	/** Empty disables nested agents; "*" enables the native OMP spawn surface. */
	spawns: string;
	profileDigest: string;
	launchProfileRef?: string;
	toolNames?: string[];
	restrictToolNames?: boolean;
	enableMCP?: boolean;
	enableLsp?: boolean;
}

export interface EngineStartRequest {
	commandId: string;
	agentInstanceId: string;
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
	kind: "accepted" | "rejected" | "running" | "completed" | "cancelled" | "failed" | "interrupted" | "reconciled";
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
	if (!Number.isSafeInteger(request.authorityGeneration) || request.authorityGeneration < 0) {
		throw new EngineTargetError("invalid_request", "authorityGeneration must be a non-negative safe integer");
	}
}
