import { describe, expect, it } from "bun:test";
import { resolveOpenAICompletionsOutputClamp } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Ark enforces its advertised `max_output_token_length` exactly: on
 * `doubao-seed-2-1-turbo-260628`, `max_completion_tokens: 262144` is accepted
 * and `262145` is rejected with `InvalidParameter`. Discovery carries that
 * value into `model.maxTokens`, so without a host clamp the generic 64k
 * OpenAI-compatible ceiling would emit `max_completion_tokens: 64000` and cut
 * every Ark route to a quarter of its output window.
 */
describe("Volcengine Ark output clamp", () => {
	it("clamps to the model's advertised output window, not the 64k default", () => {
		const spec = getBundledModel("volcengine", "doubao-seed-2-1-pro-260628") as
			| ModelSpec<"openai-completions">
			| undefined;
		expect(spec).toBeDefined();
		if (!spec) return;

		const clamp = resolveOpenAICompletionsOutputClamp(buildModel(spec), buildOpenAICompat(spec));

		expect(clamp).toBe(spec.maxTokens ?? 0);
		expect(clamp).toBeGreaterThan(64_000);
	});
});
