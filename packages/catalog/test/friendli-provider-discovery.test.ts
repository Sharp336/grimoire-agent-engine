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
 *   - `reasoning_options` (array) → `thinking.efforts` when `type: "effort"` present
 *   - `interleaved: "reasoning_content"` → `reasoningContentField` compat override
 *   - `context_length` / `max_completion_tokens` → numeric limits
 *
 * The bundled `friendli` slice in `models.json` carries the GLM-5.2 seed, so
 * `mapModel` exercises `createReferenceResolver` as the offline fallback when
 * `/v1/models` does not yet expose `reasoning_options` `type: "effort"`.
 */
import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { friendliModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Friendli provider discovery", () => {
	test("maps /v1/models metadata to resolved model specs", async () => {
		const fetchMock: FetchImpl = async (_input: string | URL | Request, _init?: RequestInit) => {
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
								input: "0.0000014",
								output: "0.0000044",
								input_cache_read: "0.00000026",
								cache_write: "0.0000003",
							},
							functionality: {
								tool_call: true,
							},
							reasoning: true,
							interleaved: "reasoning_content",
							input_modalities: ["text", "image"],
							reasoning_options: [
								{ type: "toggle" },
								{ type: "effort", values: ["high", "max"] },
								{ type: "budget_tokens", min: -1, max: 1048576 },
							],
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

		const options = friendliModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models).toHaveLength(2);

		// GLM-5.2 — reasoning + vision + interleaved + effort ladder from API
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
		expect(glm?.cost.input).toBeCloseTo(1.4, 10);
		expect(glm?.cost.output).toBeCloseTo(4.4, 10);
		expect(glm?.cost.cacheRead).toBeCloseTo(0.26, 10);
		expect(glm?.cost.cacheWrite).toBeCloseTo(0.3, 10);
		// interleaved: "reasoning_content" → reasoningContentField compat override
		expect(glm?.compat?.reasoningContentField).toBe("reasoning_content");
		// Explicit tool_call: true must set supportsTools: true, overriding any
		// reference's host-specific false.
		expect(glm?.supportsTools).toBe(true);
		// reasoning_options `type: "effort"` → thinking.efforts resolved from API
		expect(glm?.thinking).toBeDefined();
		expect(glm?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);

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
		// No reasoning → no thinking
		expect(llama?.thinking).toBeUndefined();
	});

	test("falls back to reference thinking when reasoning_options lacks type:effort", async () => {
		// Pre-rollout: API returns reasoning_options with toggle + budget_tokens
		// but no `type: "effort"`. The static seed's `thinking` must be used.
		const fetchMock: FetchImpl = async (_input: string | URL | Request, _init?: RequestInit) => {
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
							},
							functionality: { tool_call: true },
							reasoning: true,
							interleaved: "reasoning_content",
							input_modalities: ["text"],
							reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 1048576 }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = friendliModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models).toHaveLength(1);
		const glm = models![0];
		expect(glm.reasoning).toBe(true);
		// No `type: "effort"` in reasoning_options → fallback to reference (static seed)
		expect(glm.thinking).toBeDefined();
		expect(glm.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
	});

	test("returns binary thinking for toggle-only reasoning model with no reference", async () => {
		// A model not in any bundled catalog: reasoning: true with a
		// `type: "toggle"` in reasoning_options but no `type: "effort"`.
		// The toggle advertises the `enable_thinking` binary control, so the
		// mapper gives the model a single-tier thinking config representing
		// it — without this, `thinking` would be undefined and callers could
		// neither enable nor disable reasoning despite the endpoint
		// supporting the toggle.
		const fetchMock: FetchImpl = async (_input: string | URL | Request, _init?: RequestInit) => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "friendli/fictional-reasoning-model",
							object: "model",
							name: "Fictional Reasoning Model",
							context_length: 163840,
							max_completion_tokens: 163840,
							pricing: {
								input: "0.0000005",
								output: "0.0000015",
							},
							functionality: { tool_call: true },
							reasoning: true,
							interleaved: false,
							input_modalities: ["text"],
							reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 163840 }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = friendliModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models).toHaveLength(1);
		const m = models![0];
		expect(m.reasoning).toBe(true);
		// Toggle-only → single-tier binary thinking config (not undefined)
		expect(m.thinking).toBeDefined();
		expect(m.thinking?.efforts).toEqual([Effort.High]);
	});

	test("does not borrow effort metadata from a cross-provider reference", async () => {
		// A model id that exists in a different provider's bundled catalog with
		// thinking.efforts, but Friendli returns reasoning: true without
		// type: "effort" in reasoning_options. The cross-provider reference's
		// effort ladder must NOT leak into the Friendli model — doing so would
		// set supportsReasoningEffort and send reasoning_effort the
		// Friendli endpoint rejects. The model still gets a single-tier binary
		// thinking config from its `type: "toggle"` entry, but NOT the
		// multi-tier effort ladder the cross-provider reference advertises.
		const fetchMock: FetchImpl = async (_input: string | URL | Request, _init?: RequestInit) => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "zai-org/GLM-4.5",
							object: "model",
							name: "GLM-4.5",
							context_length: 131072,
							max_completion_tokens: 8192,
							pricing: { input: "0.0000004", output: "0.0000016" },
							functionality: { tool_call: true },
							reasoning: true,
							input_modalities: ["text"],
							reasoning_options: [{ type: "toggle" }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = friendliModelManagerOptions({ apiKey: "test", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models).toHaveLength(1);
		const m = models![0];
		expect(m.reasoning).toBe(true);
		// Toggle-only → binary thinking config from Friendli's own toggle
		// entry — NOT the multi-tier effort ladder a cross-provider reference
		// might advertise for the same model id.
		expect(m.thinking).toBeDefined();
		expect(m.thinking?.efforts).toEqual([Effort.High]);
	});

	test("uses the bundled reference cost as-is when /v1/models omits a pricing field", async () => {
		// The seeded GLM-5.2 carries the authoritative per-million fallback
		// (input 1.4 / output 4.4). When Friendli omits a pricing field, the
		// reference cost must pass through unscaled — it is already in
		// per-million-token units. Scaling it by 1e6 would report
		// 1400000/4400000 instead of the intended 1.4/4.4.
		const fetchMock: FetchImpl = async (_input: string | URL | Request, _init?: RequestInit) => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "zai-org/GLM-5.2",
							object: "model",
							name: "GLM-5.2",
							context_length: 131072,
							max_completion_tokens: 8192,
							// pricing omitted entirely
							functionality: { tool_call: true },
							reasoning: true,
							input_modalities: ["text"],
							reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 1048576 }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = friendliModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models).toHaveLength(1);
		const glm = models![0];
		// Reference fallback (per-million) flows through unscaled — NOT
		// multiplied by 1e6.
		expect(glm.cost.input).toBe(1.4);
		expect(glm.cost.output).toBe(4.4);
		expect(glm.cost.cacheRead).toBe(0.26);
		expect(glm.cost.cacheWrite).toBe(0);
	});

	test("accepts zero API prices for free or promotional models", async () => {
		// When Friendli reports "0" for an input/output price (e.g. a free or
		// promotional model), the mapper must accept it as an authoritative
		// API price — not fall back to the reference. The seeded GLM-5.2
		// reference carries 1.4/4.4, so a zero-reporting free model would
		// incorrectly show 1.4/4.4 if zero were rejected.
		const fetchMock: FetchImpl = async (_input: string | URL | Request, _init?: RequestInit) => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "zai-org/GLM-5.2",
							object: "model",
							name: "GLM-5.2",
							context_length: 131072,
							max_completion_tokens: 8192,
							pricing: { input: "0", output: "0" },
							functionality: { tool_call: true },
							reasoning: true,
							input_modalities: ["text"],
							reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 1048576 }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = friendliModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models).toHaveLength(1);
		const glm = models![0];
		// Zero is a valid API price — NOT the reference fallback (1.4/4.4).
		expect(glm.cost.input).toBe(0);
		expect(glm.cost.output).toBe(0);
	});
});
