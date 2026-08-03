import { describe, expect, test } from "bun:test";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	FEATHERLESS_DEFAULT_MODEL,
	featherlessModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Featherless built-in provider", () => {
	test("registers an initially empty bounded-search provider with GLM 5.2 as its default", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "featherless");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("zai-org/GLM-5.2");
		expect(descriptor?.dynamicModelsAuthoritative).toBeUndefined();
		expect(descriptor?.catalogDiscovery).toBeUndefined();
		expect(DEFAULT_MODEL_PER_PROVIDER.featherless).toBe("zai-org/GLM-5.2");
		expect(FEATHERLESS_DEFAULT_MODEL.id).toBe("zai-org/GLM-5.2");
		const options = featherlessModelManagerOptions();
		expect(options.dynamicModelsAuthoritative).toBe(false);
		expect(options.dynamicModelsPartial).toBe(true);
		expect(getBundledProviders()).not.toContain("featherless");
	});

	test("caches one bounded conversational API page on demand, ordered by context then newest age", async () => {
		const requests: string[] = [];
		const totals: Array<[number, string]> = [];
		const fetchMock: FetchImpl = async input => {
			requests.push(String(input));
			const models = Array.from({ length: 25 }, (_, index) => ({
				id: `example/tool-${index}`,
				context_length: index < 10 ? 131_072 : 65_536,
				created: 1_700_000_000 + index,
				pricing: { input: 0.1, output: 0.2 },
				features: { tool_use: true },
				available_on_current_plan: true,
			}));
			return Response.json({
				total: 43_750,
				data: [
					...models,
					{
						id: "example/no-tools",
						context_length: 1_000_000,
						created: 1_800_000_000,
						features: {},
					},
				],
			});
		};
		const options = featherlessModelManagerOptions({
			apiKey: "featherless-test-key",
			fetch: fetchMock,
			onModelCount: (count, query) => totals.push([count, query]),
		});

		const models = await options.fetchDynamicModels?.();

		expect(models).toHaveLength(27);
		expect(models?.map(model => model.id)).toEqual([
			"example/no-tools",
			"zai-org/GLM-5.2",
			...Array.from({ length: 10 }, (_, index) => `example/tool-${9 - index}`),
			...Array.from({ length: 15 }, (_, index) => `example/tool-${24 - index}`),
		]);
		expect(models?.find(model => model.id === "example/no-tools")?.supportsTools).toBe(false);
		expect(models?.map(model => model.priority)).toEqual(Array.from({ length: 27 }, (_, index) => index));
		expect(requests).toEqual([
			"https://api.featherless.ai/v1/models?conversational=true&per_page=100&sort=-popularity&available_on_current_plan=true",
		]);
		expect(totals).toEqual([[43_750, ""]]);
	});

	test("searches remotely and marks non-tool conversational models", async () => {
		const requests: Array<{ url: string; headers: Headers }> = [];
		const totals: Array<[number, string]> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), headers: new Headers(init?.headers) });
			return Response.json({
				total: 2,
				data: [
					{
						id: "zai-org/GLM-5.2",
						context_length: 262144,
						pricing: { input: 1.39, output: 4.4 },
						features: { tool_use: true },
						available_on_current_plan: true,
					},
					{
						id: "example/no-tools",
						context_length: 32768,
						pricing: { prompt: "0.0000001", completion: "0.0000002" },
						features: {},
					},
				],
			});
		};
		const options = featherlessModelManagerOptions({
			apiKey: "featherless-test-key",
			fetch: fetchMock,
			onModelCount: (count, query) => totals.push([count, query]),
		});

		const models = await options.searchDynamicModels?.("GLM 5.2");

		expect(models?.map(model => model.id)).toEqual(["zai-org/GLM-5.2", "example/no-tools"]);
		expect(models?.[0]).toMatchObject({
			name: "GLM 5.2",
			provider: "featherless",
			baseUrl: "https://api.featherless.ai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1.39, output: 4.4, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: null,
			thinking: { mode: "effort", efforts: ["high"] },
			compat: { thinkingFormat: "qwen-chat-template", replayReasoningContent: true },
		});
		expect(models?.[1]?.supportsTools).toBe(false);
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.url).toBe(
			"https://api.featherless.ai/v1/models?q=GLM+5.2&conversational=true&per_page=100&sort=-popularity&available_on_current_plan=true",
		);
		expect(request.headers.get("authorization")).toBe("Bearer featherless-test-key");
		expect(request.headers.get("http-referer")).toBe("https://omp.sh/");
		expect(request.headers.get("x-title")).toBe("Oh-My-Pi");
		expect(totals).toEqual([[2, "GLM 5.2"]]);
	});

	test("finds flagship tool models omitted by Featherless capability search", async () => {
		const flagshipModels = new Map([
			["glm", "zai-org/GLM-5.2"],
			["kimi", "moonshotai/Kimi-K2.5"],
			["minimax", "MiniMaxAI/MiniMax-M2.5"],
		]);
		const requests: URL[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = new URL(String(input));
			requests.push(url);
			const id = flagshipModels.get(url.searchParams.get("q") ?? "");
			if (!id || url.searchParams.has("capabilities")) {
				return Response.json({ total: 0, data: [] });
			}
			return Response.json({
				total: 1,
				data: [
					{
						id,
						context_length: 262_144,
						features: { tool_use: true },
						available_on_current_plan: true,
					},
				],
			});
		};
		const options = featherlessModelManagerOptions({ apiKey: "featherless-test-key", fetch: fetchMock });

		for (const [query, id] of flagshipModels) {
			expect((await options.searchDynamicModels?.(query))?.map(model => model.id)).toEqual([id]);
		}
		expect(requests).toHaveLength(3);
		expect(requests.every(request => !request.searchParams.has("capabilities"))).toBe(true);
	});

	test("orders remote search results by context window then creation time", async () => {
		const fetchMock: FetchImpl = async () =>
			Response.json({
				total: 3,
				data: [
					{
						id: "example/small-new",
						context_length: 32_768,
						created: 1_800_000_000,
						features: { tool_use: true },
					},
					{
						id: "example/large-old",
						context_length: 262_144,
						created: 1_700_000_000,
						features: { tool_use: true },
					},
					{
						id: "example/large-new",
						context_length: 262_144,
						created: 1_800_000_000,
						features: { tool_use: true },
					},
				],
			});
		const options = featherlessModelManagerOptions({ fetch: fetchMock });

		const models = await options.searchDynamicModels?.("example");

		expect(models?.map(model => model.id)).toEqual(["example/large-new", "example/large-old", "example/small-new"]);
		expect(models?.map(model => model.priority)).toEqual([0, 1, 2]);
	});
});
