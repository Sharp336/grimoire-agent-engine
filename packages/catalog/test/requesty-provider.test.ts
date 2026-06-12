import { describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { requestyModelManagerOptions, UNK_MAX_TOKENS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const fetchModelsResponse = (entries: object[]): FetchImpl =>
	vi.fn(
		async () =>
			new Response(JSON.stringify({ object: "list", data: entries }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as typeof fetch;

describe("requesty provider support", () => {
	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(d => d.providerId === "requesty");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("minimaxi/minimax-m3");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("REQUESTY_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.requesty).toBe("minimaxi/minimax-m3");
	});

	test("options carry dynamicModelsAuthoritative and unconditional fetchDynamicModels", () => {
		const options = requestyModelManagerOptions({ apiKey: "rqsty-test-key" });
		expect(options.providerId).toBe("requesty");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.fetchDynamicModels).toBeDefined();
	});

	test("fetchDynamicModels is present even without an api key (public endpoint)", () => {
		const options = requestyModelManagerOptions();
		expect(options.fetchDynamicModels).toBeDefined();
	});

	test("converts per-token pricing to per-million for caching model", async () => {
		const fetchMock = fetchModelsResponse([
			{
				id: "anthropic/claude-sonnet-4-5",
				api: "chat",
				supports_tool_calling: true,
				supports_caching: true,
				supports_vision: true,
				supports_reasoning: true,
				input_price: 3e-6,
				output_price: 1.5e-5,
				cached_price: 3e-7,
				caching_price: 3.75e-6,
				context_window: 200_000,
				max_output_tokens: 64_000,
			},
		]);
		const models = await requestyModelManagerOptions({
			apiKey: "rqsty-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		const model = models?.find(m => m.id === "anthropic/claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(model?.cost.input).toBe(3); // 3e-6 * 1_000_000
		expect(model?.cost.output).toBe(15); // 1.5e-5 * 1_000_000
		expect(model?.cost.cacheRead).toBe(0.3); // 3e-7 * 1_000_000
		expect(model?.cost.cacheWrite).toBe(3.75); // 3.75e-6 * 1_000_000
		expect(model?.contextWindow).toBe(200_000);
		expect(model?.maxTokens).toBe(64_000);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.reasoning).toBe(true);
	});

	test("zeroes cache fields when supports_caching is false even though cached_price is present", async () => {
		// xai/grok-3-mini pattern from live endpoint: cached_price mirrors input_price,
		// supports_caching: false — surfacing it as cacheRead would report false savings.
		const fetchMock = fetchModelsResponse([
			{
				id: "xai/grok-3-mini",
				api: "chat",
				supports_tool_calling: true,
				supports_caching: false,
				supports_vision: false,
				supports_reasoning: true,
				input_price: 3e-7,
				output_price: 5e-7,
				cached_price: 3e-7,
				context_window: 131_072,
				max_output_tokens: 0,
			},
		]);
		const models = await requestyModelManagerOptions({
			apiKey: "rqsty-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		const model = models?.find(m => m.id === "xai/grok-3-mini");
		expect(model).toBeDefined();
		expect(model?.cost.cacheRead).toBe(0);
		expect(model?.cost.cacheWrite).toBe(0);
	});

	test("max_output_tokens: 0 falls back to UNK_MAX_TOKENS", async () => {
		const fetchMock = fetchModelsResponse([
			{
				id: "xai/grok-3-mini",
				api: "chat",
				supports_tool_calling: true,
				supports_caching: false,
				input_price: 3e-7,
				output_price: 5e-7,
				context_window: 131_072,
				max_output_tokens: 0,
			},
		]);
		const models = await requestyModelManagerOptions({
			apiKey: "rqsty-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		expect(models?.find(m => m.id === "xai/grok-3-mini")?.maxTokens).toBe(UNK_MAX_TOKENS);
	});

	test("filterModel drops supports_tool_calling: false entries", async () => {
		const fetchMock = fetchModelsResponse([
			{
				id: "keep/tool-capable",
				api: "chat",
				supports_tool_calling: true,
				input_price: 1e-6,
				output_price: 2e-6,
				context_window: 8_000,
				max_output_tokens: 4_000,
			},
			{
				id: "drop/no-tools",
				api: "chat",
				supports_tool_calling: false,
				input_price: 1e-6,
				output_price: 2e-6,
				context_window: 8_000,
				max_output_tokens: 4_000,
			},
		]);
		const models = await requestyModelManagerOptions({
			apiKey: "rqsty-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		const ids = models?.map(m => m.id);
		expect(ids).toContain("keep/tool-capable");
		expect(ids).not.toContain("drop/no-tools");
	});

	test("standard OpenAI-style entries without Requesty extension fields are accepted", async () => {
		// If Requesty ever returns bare OpenAI-compatible objects (no api, no
		// supports_tool_calling), the filter must not reject every model.
		const fetchMock = fetchModelsResponse([
			{
				id: "openai/gpt-4o",
				object: "model",
				created: 1_700_000_000,
				owned_by: "openai",
				input_price: 2.5e-6,
				output_price: 1e-5,
				context_window: 128_000,
				max_output_tokens: 16_384,
			},
		]);
		const models = await requestyModelManagerOptions({
			apiKey: "rqsty-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		expect(models?.find(m => m.id === "openai/gpt-4o")).toBeDefined();
	});

	test("reasoningEffortMap translates minimal→min and xhigh→max for Requesty's API", async () => {
		const fetchMock = fetchModelsResponse([
			{
				id: "openai/o3-mini",
				api: "chat",
				supports_tool_calling: true,
				supports_reasoning: true,
				input_price: 1e-6,
				output_price: 4e-6,
				context_window: 200_000,
				max_output_tokens: 100_000,
			},
		]);
		const models = await requestyModelManagerOptions({
			apiKey: "rqsty-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		const model = models?.find(m => m.id === "openai/o3-mini");
		expect(model?.compat?.reasoningEffortMap?.minimal).toBe("min");
		expect(model?.compat?.reasoningEffortMap?.xhigh).toBe("max");
	});
});
