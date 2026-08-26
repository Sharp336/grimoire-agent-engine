import delegatedBoundaryPrompt from "../prompts/system/vibe-delegated-worker-boundary.md" with { type: "text" };

export const VIBE_DELEGATED_WORKER_BOUNDARY = delegatedBoundaryPrompt.trim();

export function buildVibeDelegatedAssignment(message: string): string {
	return `${VIBE_DELEGATED_WORKER_BOUNDARY}\n\nAssignment:\n${message}`;
}
