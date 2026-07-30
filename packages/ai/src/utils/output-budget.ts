/**
 * Request-side output-token budget clamp.
 *
 * On APIs where max output tokens is mandatory on the wire (anthropic, bedrock),
 * a prompt that fits the context window on its own can still be rejected once
 * the declared output allowance pushes prompt + output past the window. This
 * module provides a conservative clamp that only ever reduces the requested
 * max, never raises it, and passes through when the window is unknown.
 *
 * It owns the two shared primitives the clamp and the providers agree on:
 * {@link OUTPUT_FALLBACK_BUFFER} (the safety buffer between thinking budget and
 * max_tokens, reused as the clamp's reserve) and {@link estimateTextTokens}
 * (the single source of the byte-heuristic token estimate, reused by
 * `packages/agent/src/tokenizer.ts`).
 */

import type { Message } from "../types";

/**
 * Image content has no tokenizer representation; charge a fixed estimate
 * matching what providers typically bill for inline images.
 */
const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Safety buffer subtracted from the remaining context window before capping
 * output, and the gap Anthropic requires between `thinking.budget_tokens` and
 * `max_tokens`. One constant so the clamp and the thinking reconciliation can
 * never drift apart.
 */
export const OUTPUT_FALLBACK_BUFFER = 4000;

/**
 * Clamp a requested max-output value so that prompt + output stays within the
 * model's context window. Only ever reduces; never raises or invents a value.
 *
 * Returns `requestedMaxTokens` unchanged when `contextWindow` is undefined or
 * <= 0 (unknown window → pass-through rather than a guess).
 */
export function clampMaxTokensToContext(args: {
	requestedMaxTokens: number;
	contextWindow: number | undefined;
	estimatedPromptTokens: number;
	reserveTokens?: number;
}): number {
	const { requestedMaxTokens, contextWindow, estimatedPromptTokens } = args;
	if (contextWindow === undefined || contextWindow <= 0) return requestedMaxTokens;
	const reserve = args.reserveTokens ?? OUTPUT_FALLBACK_BUFFER;
	const budget = Math.max(1, contextWindow - estimatedPromptTokens - reserve);
	return Math.min(requestedMaxTokens, budget);
}

/**
 * Estimate prompt token count using the byte heuristic `(bytes + 3) >> 2`.
 * Counts the system prompt, every replayed content block (text, images,
 * thinking, redacted thinking, tool calls, native server-tool results, and
 * fallback markers), and serialized tools. Adds a fixed per-image estimate.
 */
export function estimatePromptTokens(
	systemPrompt: string | undefined,
	messages: readonly Message[],
	tools?: readonly unknown[],
): number {
	let tokens = 0;

	if (systemPrompt) {
		tokens += estimateTextTokens(systemPrompt);
	}

	for (const message of messages) {
		const content = message.content;
		if (typeof content === "string") {
			tokens += estimateTextTokens(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") {
					tokens += estimateTextTokens(block.text);
				} else if (block.type === "image") {
					tokens += IMAGE_TOKEN_ESTIMATE;
				} else if (block.type === "thinking") {
					tokens += estimateTextTokens(block.thinking);
				} else if (block.type === "redactedThinking") {
					tokens += estimateTextTokens(block.data);
				} else if (block.type === "toolCall") {
					tokens += estimateTextTokens(JSON.stringify({ name: block.name, arguments: block.arguments }));
				} else if (block.type === "anthropicServerTool") {
					// Verbatim server-tool call/result (e.g. web_search_tool_result)
					// replayed on the wire — potentially large, so charge its
					// serialized form like the agent's compaction estimator.
					tokens += estimateTextTokens(JSON.stringify(block.block));
				} else if (block.type === "fallback") {
					tokens += estimateTextTokens(JSON.stringify(block));
				}
			}
		}
	}

	if (tools && tools.length > 0) {
		tokens += estimateTextTokens(JSON.stringify(tools));
	}

	return tokens;
}

/**
 * Byte heuristic: ~4 bytes per token, rounded up. The single source for this
 * estimate — `packages/agent/src/tokenizer.ts` reuses it instead of forking it.
 */
export function estimateTextTokens(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}
