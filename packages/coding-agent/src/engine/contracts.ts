export type EngineAttemptState = "accepted" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
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
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	cwd: string;
	input: string;
}

export interface EngineTarget {
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	engineGeneration: number;
	bindingGeneration: number;
}

export interface EngineSteerRequest extends EngineTarget {
	commandId: string;
	message: string;
}

export interface EngineCancelRequest extends EngineTarget {
	reason?: string;
}

export interface EnginePeerMessage {
	messageId: string;
	fromAgentInstanceId: string;
	toAgentInstanceId: string;
	body: string;
}

export interface EngineBindingSnapshot extends EngineTarget {
	bindingId: string;
	engineAgentId: string;
	sessionFile?: string;
	profileDigest: string;
	state: EngineBindingState;
}

export interface EngineStartResult extends EngineBindingSnapshot {
	duplicate: boolean;
}

export interface EngineEvent {
	eventId: number;
	seq: number;
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	engineGeneration: number;
	bindingGeneration: number;
	kind: "accepted" | "running" | "completed" | "cancelled" | "failed" | "interrupted" | "reconciled";
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
	for (const [name, value] of Object.entries(request)) {
		if (typeof value !== "string" || !value.trim()) {
			throw new EngineTargetError("invalid_request", `${name} must be a non-empty string`);
		}
	}
}
