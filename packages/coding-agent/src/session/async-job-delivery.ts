/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */
import { formatDuration, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobProgressDelivery, AsyncJobType } from "../async";
import type { ProgressReminder } from "../async/progress-batcher";
import chattyProgressGuidanceTemplate from "../prompts/system/chatty-progress-guidance.md" with { type: "text" };
import asyncProgressTemplate from "../prompts/tools/async-progress.md" with { type: "text" };
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { CustomMessage } from "./messages";
import { buildProgressPreview } from "./progress-preview";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";
export const ASYNC_PROGRESS_MESSAGE_TYPE = "async-progress";
/** Separate queue kind whose idle flush starts a follow-up turn. Messages retain the shared progress custom type. */
export const ASYNC_PROGRESS_WAKE_QUEUE_KIND = "async-progress-wake";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;
export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
}

export interface AsyncProgressEntry {
	jobId: string;
	text: string;
	job: AsyncJob | undefined;
	source?: AsyncProgressSource;
	seq: number;
	elapsedMs: number;
	epoch: number;
	delivery: AsyncJobProgressDelivery;
	artifactId?: string;
	sourceTruncated?: boolean;
	suppressedEvents?: number;
	reminder?: ProgressReminder;
}

export type AsyncProgressSourceType = "bash" | "task" | "process";

export interface AsyncProgressSource {
	id: string;
	type: AsyncProgressSourceType;
	label: string;
	startedAt: number;
}

type AsyncProgressJobDetails = {
	jobId: string;
	type?: AsyncProgressSourceType;
	label?: string;
	elapsedMs: number;
	text?: string;
	hasOutput: boolean;
	head?: string;
	tail?: string;
	artifactId?: string;
	truncated?: boolean;
	suppressedEvents?: number;
	reminder?: ProgressReminder;
};

export type AsyncProgressDetails = {
	jobs: AsyncProgressJobDetails[];
};

/** Build one progress message, preserving every rate-limit-permitted event and grouping entries by job. */
export function buildAsyncProgressBatchMessage(
	entries: AsyncProgressEntry[],
): CustomMessage<AsyncProgressDetails> | null {
	if (entries.length === 0) return null;
	const entriesByJob = new Map<string, AsyncProgressEntry[]>();
	for (const entry of entries) {
		const queued = entriesByJob.get(entry.jobId);
		if (queued) {
			queued.push(entry);
			continue;
		}
		entriesByJob.set(entry.jobId, [entry]);
	}

	const jobs = Array.from(entriesByJob.values()).map(jobEntries => {
		const latest = jobEntries.at(-1)!;
		const type = latest.job?.type;
		const fullText = jobEntries
			.map(entry => sanitizeText(entry.text))
			.filter(Boolean)
			.join("\n");
		const hasOutput = fullText.length > 0;
		const suppressedEvents = jobEntries.reduce((total, entry) => total + (entry.suppressedEvents ?? 0), 0);
		const sourceTruncated = suppressedEvents > 0 || jobEntries.some(entry => entry.sourceTruncated);
		const preview = buildProgressPreview(fullText, sourceTruncated);
		const truncated = hasOutput && preview.truncated;
		const artifactId = [...jobEntries].reverse().find(entry => entry.artifactId)?.artifactId;
		const reminder = jobEntries.find(entry => entry.reminder !== undefined)?.reminder;
		return {
			jobId: latest.jobId,
			type: latest.source?.type ?? (type === "eval" ? undefined : type),
			label: latest.source?.label ?? latest.job?.label,
			elapsedMs: latest.elapsedMs,
			text: hasOutput ? preview.text : undefined,
			hasOutput,
			head: preview.head,
			tail: preview.tail,
			artifactId,
			truncated,
			suppressedEvents: suppressedEvents || undefined,
			reminder,
		};
	});
	const chattyJobs = jobs.filter(
		job => job.reminder === "chatty-monitor" && (job.type === "bash" || job.type === "process"),
	);
	const chattyGuidance =
		chattyJobs.length === 0
			? undefined
			: prompt
					.render(chattyProgressGuidanceTemplate, {
						bash: chattyJobs.some(job => job.type === "bash"),
						hub: chattyJobs.some(job => job.type === "process"),
					})
					.trim();
	return {
		role: "custom",
		customType: ASYNC_PROGRESS_MESSAGE_TYPE,
		content: prompt.render(asyncProgressTemplate, {
			wake: entries.some(entry => entry.delivery === "wake"),
			multiple: jobs.length > 1,
			jobs: jobs.map(job => ({ ...job, elapsed: formatDuration(job.elapsedMs) })),
			chattyGuidance,
		}),
		display: true,
		attribution: "agent",
		details: { jobs },
		timestamp: Date.now(),
	};
}

export type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
	status?: AsyncJob["status"];
	exitCode?: number;
	timedOut?: boolean;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => {
		const rawExitCode = entry.job?.latestDetails?.exitCode;
		const exitCode = typeof rawExitCode === "number" ? rawExitCode : undefined;
		const timedOut = entry.job?.latestDetails?.timedOut === true;
		const status = entry.job?.status;
		return {
			jobId: entry.jobId,
			result: entry.result,
			type: entry.job?.type,
			label: entry.job?.label,
			durationMs: entry.durationMs,
			status,
			timedOut,
			bash: entry.job?.type === "bash",
			exitCode,
			failed: status === "failed" || timedOut || (exitCode !== undefined && exitCode !== 0),
			hasExitCode: exitCode !== undefined,
		};
	});
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
			status: job.status,
			exitCode: job.exitCode,
			timedOut: job.timedOut,
		})),
	};
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
