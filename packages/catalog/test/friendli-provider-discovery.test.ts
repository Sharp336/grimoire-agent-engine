/**
 * Discovery contract test for `friendliModelManagerOptions`.
 *
 * Friendli's `/v1/models` endpoint returns model metadata under non-standard
 * field names that the custom `mapModel` must translate:
 *   - `pricing.input`/`pricing.output` → per-million-token cost
 *   - `pricing.input_cache_read`/`pricing.cache_write` → cache cost
 *   - `functionality.tool_call` (boolean) → `supportsTools: false` when absent
 *   - `input_modalities` (array) → vision flag
 *   - `reasoning` (boolean) → reasoning flag
 *   - `interleaved: "reasoning_content"` → `reasoningContentField` compat override
 *   - `context_length` / `max_completion_tokens` → numeric limits
 *
 * The bundled `friendli` slice in `models.json` is empty, so `mapModel`
 * also exercises the `createReferenceResolver` cross-provider fallback to
 * recover reasoning/thinking metadata from other providers' bundled entries.
 */
import { describe, expect, test } from "bun:test";
import { friendliModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Friendli provider discovery", () => {
	test("maps /v1/models metadata to resolved model specs", async () => {
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "zai-org/GLM-5.2",
							object: "model",
							name: "GLM-5.2",
							context_length: 131072,
							max_completion_tokens: 8192,
							pricing: {
								input: "0.0000006",
								output: "0.0000022",
								input_cache_read: "0.0000001",
								cache_write: "0.0000003",
							},
							functionality: {
								tool_call: true,
							},
							reasoning: true,
							interleaved: "reasoning_content",
							input_modalities: ["text", "image"],
						},
						{
							id: "meta-llama/Llama-4-9B",
							object: "model",
							name: "Llama 4 9B",
							context_length: 1048576,
							max_completion_tokens: 16384,
							pricing: {
								input: "0.0000001",
								output: "0.0000006",
							},
							functionality: {
								tool_call: false,
							},
							reasoning: false,
							interleaved: null,
							input_modalities: ["text"],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = friendliModelManagerOptions({ apiKey: "flp_test_key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models).toHaveLength(2);

		// GLM-5.2 — reasoning + vision + interleaved
		// functionality.tool_call: true → supportsTools: true
		const glm = models!.find(m => m.id === "zai-org/GLM-5.2");
		expect(glm).toBeDefined();
		expect(glm?.provider).toBe("friendli");
		expect(glm?.api).toBe("openai-completions");
		expect(glm?.name).toBe("GLM-5.2");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.input).toEqual(["text", "image"]);
		expect(glm?.contextWindow).toBe(131_072);
		expect(glm?.maxTokens).toBe(8_192);
		// pricing fields are per-token strings → converted to per-million
		expect(glm?.cost.input).toBeCloseTo(0.6, 10);
		expect(glm?.cost.output).toBeCloseTo(2.2, 10);
		expect(glm?.cost.cacheRead).toBeCloseTo(0.1, 10);
		expect(glm?.cost.cacheWrite).toBeCloseTo(0.3, 10);
		// interleaved: "reasoning_content" → reasoningContentField compat override
		expect(glm?.compat?.reasoningContentField).toBe("reasoning_content");
		// Explicit tool_call: true must set supportsTools: true, overriding any
		// reference's host-specific false.
		expect(glm?.supportsTools).toBe(true);

		// Llama 4 9B — no reasoning, no vision, tools disabled
		const llama = models!.find(m => m.id === "meta-llama/Llama-4-9B");
		expect(llama).toBeDefined();
		expect(llama?.provider).toBe("friendli");
		expect(llama?.api).toBe("openai-completions");
		expect(llama?.name).toBe("Llama 4 9B");
		expect(llama?.reasoning).toBe(false);
		// Explicit input_modalities: ["text"] → must NOT inherit vision from reference
		expect(llama?.input).toEqual(["text"]);
		expect(llama?.contextWindow).toBe(1_048_576);
		expect(llama?.maxTokens).toBe(16_384);
		expect(llama?.cost.input).toBeCloseTo(0.1, 10);
		expect(llama?.cost.output).toBeCloseTo(0.6, 10);
		expect(llama?.cost.cacheRead).toBe(0);
		expect(llama?.cost.cacheWrite).toBe(0);
		// functionality.tool_call === false → supportsTools: false
		expect(llama?.supportsTools).toBe(false);
	});
});
