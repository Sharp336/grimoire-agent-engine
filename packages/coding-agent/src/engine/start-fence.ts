import { EngineTargetError } from "./contracts";

/** A trusted delivery reference to one immutable Start, never a replacement for general intent CAS. */
export interface EngineStartFence {
	pendingStartCommandId?: string;
	expectedStartIntentRevision?: number;
	principalId?: string;
}

export interface EnginePendingStartTarget extends EngineStartFence {
	agentInstanceId: string;
	executionId: string;
	attemptId: string;
	authorityGeneration: number;
	engineGeneration: number;
	expectedIntentRevision?: number;
}

export function validateStartFence(target: EngineStartFence): boolean {
	const hasId = target.pendingStartCommandId !== undefined;
	const hasRevision = target.expectedStartIntentRevision !== undefined;
	if (
		hasId !== hasRevision ||
		(hasId &&
			(!target.pendingStartCommandId?.trim() ||
				!Number.isSafeInteger(target.expectedStartIntentRevision) ||
				target.expectedStartIntentRevision! < 0))
	)
		throw new EngineTargetError("invalid_request", "Start cancellation reference requires both command and revision");
	return hasId;
}
