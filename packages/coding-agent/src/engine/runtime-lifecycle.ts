import type { EngineEvent } from "./contracts";

const lifecycleKinds = {
	running: ["started", "Attempt started"],
	paused: ["paused", "Paused"],
	resumed: ["running", "Resumed"],
	input_requested: ["waiting", "Needs input"],
	input_resolved: ["running", "Input received"],
	retry_scheduled: ["waiting", "Retry scheduled"],
	retry_settled: ["settled", "Retry settled"],
	interrupted: ["failed", "Interrupted"],
	completed: ["succeeded", "Completed"],
	cancelled: ["cancelled", "Stopped"],
	failed: ["failed", "Failed"],
	rejected: ["failed", "Command rejected"],
} as const;

export function lifecycleSummary(event: Pick<EngineEvent, "kind" | "payload">): string | null {
	if (!Object.hasOwn(lifecycleKinds, event.kind)) return null;
	const value = event.payload ?? {};
	const retry = value.retry as { attempt?: number; maxAttempts?: number; route?: string; error?: string } | undefined;
	if (retry)
		return [
			retry.attempt === undefined ? "" : `attempt ${retry.attempt}/${retry.maxAttempts}`,
			retry.route,
			retry.error,
		]
			.filter(Boolean)
			.join(" · ")
			.slice(0, 500);
	const error = value.error;
	return (
		typeof error === "string"
			? error
			: error && typeof error === "object" && "message" in error
				? String(error.message)
				: ""
	).slice(0, 500);
}

export interface HistoryLifecycleContext {
	agentInstanceId: string;
	sessionPath: string;
	sessionId: string;
	lineage: string;
	anchor: string | null;
	first: string | null;
	count: number;
	currentAttemptId: string | null;
	targetAttemptId: string | null;
	watermark: number;
}
