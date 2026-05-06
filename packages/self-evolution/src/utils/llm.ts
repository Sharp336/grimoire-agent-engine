/**
 * LLM wrapper for background calls (skill refinement, reranking, prompt optimization).
 */

import type { Context, Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Send a simple text-completion request to the given model.
 * Returns empty string on failure so callers can fall back to rule-based behavior.
 */
export async function callBackgroundLlm(
	model: Model | undefined,
	systemPrompt: string,
	userPrompt: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!model) {
		logger.debug("Background LLM skipped: no model available");
		return "";
	}

	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
	};

	try {
		const result = await completeSimple(model, context, { signal, maxTokens: 2000 });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("");
		return text.trim();
	} catch (err) {
		logger.warn("Background LLM call failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return "";
	}
}
