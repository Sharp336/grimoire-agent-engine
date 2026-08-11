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
import type { Usage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { CustomMessage } from "./messages";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

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

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	durationMs?: number;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
	/**
	 * Aggregated LLM usage across the delivered jobs (task jobs that reported
	 * usage). Lets the session's usage index count background subagent cost the
	 * same way it counts sync task tool-results.
	 */
	usage?: Usage;
};

function aggregateJobUsage(entries: AsyncResultEntry[]): Usage | undefined {
	const totals: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let orchestrationInput = 0;
	let orchestrationOutput = 0;
	let orchestrationCacheRead = 0;
	let premiumRequests = 0;
	let sawUsage = false;
	for (const entry of entries) {
		const usage = entry.job?.resultUsage;
		if (!usage) continue;
		sawUsage = true;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.totalTokens += usage.totalTokens ?? 0;
		const cost = usage.cost;
		if (cost) {
			totals.cost.input += cost.input ?? 0;
			totals.cost.output += cost.output ?? 0;
			totals.cost.cacheRead += cost.cacheRead ?? 0;
			totals.cost.cacheWrite += cost.cacheWrite ?? 0;
			totals.cost.total += cost.total ?? 0;
		}
		orchestrationInput += usage.orchestration?.input ?? 0;
		orchestrationOutput += usage.orchestration?.output ?? 0;
		orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
		premiumRequests += usage.premiumRequests ?? 0;
	}
	if (!sawUsage) return undefined;
	if (orchestrationInput || orchestrationOutput || orchestrationCacheRead) {
		totals.orchestration = {
			input: orchestrationInput,
			output: orchestrationOutput,
			cacheRead: orchestrationCacheRead,
		};
	}
	if (premiumRequests > 0) totals.premiumRequests = premiumRequests;
	return totals;
}

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
		usage: aggregateJobUsage(entries),
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
