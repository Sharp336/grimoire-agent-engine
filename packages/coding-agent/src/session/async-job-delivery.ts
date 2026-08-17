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
import type { AsyncJob } from "../async";
import asyncProgressTemplate from "../prompts/tools/async-progress.md" with { type: "text" };
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { CustomMessage } from "./messages";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";
export const ASYNC_PROGRESS_MESSAGE_TYPE = "async-progress";

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
	seq: number;
	elapsedMs: number;
	epoch: number;
}

type AsyncProgressJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	elapsedMs: number;
	text: string;
};

export type AsyncProgressDetails = {
	jobs: AsyncProgressJobDetails[];
};

const ASYNC_PROGRESS_MAX_LINES_PER_JOB = 3;
const ASYNC_PROGRESS_MAX_CHARS = 4_000;

function capProgressText(text: string, maxChars: number): string {
	const lines = sanitizeText(text)
		.split("\n")
		.filter(line => line.trim().length > 0)
		.slice(-ASYNC_PROGRESS_MAX_LINES_PER_JOB);
	const joined = lines.join("\n");
	if (joined.length <= maxChars) return joined;
	return joined.slice(-maxChars);
}

/** Build one bounded aside, keeping only the newest update for each job. */
export function buildAsyncProgressBatchMessage(
	entries: AsyncProgressEntry[],
): CustomMessage<AsyncProgressDetails> | null {
	if (entries.length === 0) return null;
	const newestByJob = new Map<string, AsyncProgressEntry>();
	for (const entry of entries) {
		const previous = newestByJob.get(entry.jobId);
		if (!previous || entry.seq >= previous.seq) newestByJob.set(entry.jobId, entry);
	}

	const survivors = Array.from(newestByJob.values());
	const perJobChars = Math.max(1, Math.floor(ASYNC_PROGRESS_MAX_CHARS / survivors.length));
	const jobs = survivors.map(entry => ({
		jobId: entry.jobId,
		type: entry.job?.type,
		label: entry.job?.label,
		elapsedMs: entry.elapsedMs,
		text: capProgressText(entry.text, perJobChars),
	}));
	return {
		role: "custom",
		customType: ASYNC_PROGRESS_MESSAGE_TYPE,
		content: prompt.render(asyncProgressTemplate, {
			multiple: jobs.length > 1,
			jobs: jobs.map(job => ({ ...job, elapsed: formatDuration(job.elapsedMs) })),
		}),
		display: true,
		attribution: "agent",
		details: { jobs },
		timestamp: Date.now(),
	};
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	durationMs?: number;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
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
