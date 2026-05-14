import type { AssistantMessage } from "../types";

/**
 * Apply Cursor's cumulative conversation-token counter (`tokenDetails.usedTokens`)
 * to a streaming assistant message. The counter is monotonically increasing across
 * a multi-turn conversation, so it is anchored on `usage.totalTokens` (which
 * {@link calculateContextTokens} and {@link calculatePromptTokens} both prefer
 * when set). The per-turn `usage.input` / `usage.cacheRead` fields are left at 0
 * so session aggregators that sum across assistant messages
 * (footer/getSessionStats) do not double-count cumulative context across turns.
 */
export function applyCursorConversationTokenDetails(output: AssistantMessage, usedTokens: number): void {
	output.usage.totalTokens = Math.max(output.usage.totalTokens, usedTokens);
}

/**
 * Apply a per-turn output-token delta and ratchet `totalTokens` so the cumulative
 * anchor written by a prior checkpoint is preserved across subsequent deltas.
 */
export function applyCursorTokenDelta(output: AssistantMessage, deltaTokens: number): void {
	output.usage.output += deltaTokens;
	applyCursorConversationTokenDetails(output, output.usage.input + output.usage.output);
}

/**
 * Cursor reports a single cumulative `totalTokens` that already includes prior
 * turns; the per-message input/output/cache splits do not always sum to it.
 * Synthesize phantom input tokens so the aggregate reconciles for display.
 */
export function reconcileCursorCumulativeTokens(totals: {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	latestCursorTotalTokens: number;
}): { totalInput: number; totalTokens: number } {
	const summedTokens = totals.totalInput + totals.totalOutput + totals.totalCacheRead + totals.totalCacheWrite;
	const totalTokens = Math.max(summedTokens, totals.latestCursorTotalTokens);
	const totalInput = totalTokens > summedTokens ? totals.totalInput + (totalTokens - summedTokens) : totals.totalInput;
	return { totalInput, totalTokens };
}
