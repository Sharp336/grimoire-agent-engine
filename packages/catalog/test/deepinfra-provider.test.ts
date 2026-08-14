import { describe, expect, test } from "bun:test";
import { deepinfraModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("DeepInfra provider discovery", () => {
	test("discovers chat models from nested metadata and excludes non-chat models", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "deepseek-ai/DeepSeek-V3",
							metadata: {
								tags: ["chat", "vision", "reasoning"],
								context_length: 163840,
								max_tokens: 32768,
								pricing: { input_tokens: 0.32, output_tokens: 0.89, cache_read_tokens: 0.16 },
							},
						},
						{ id: "sentence-transformers/all-MiniLM-L6-v2", metadata: { tags: ["embed"] } },
						{ id: "unknown/model-without-metadata" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = deepinfraModelManagerOptions({ apiKey: "deepinfra-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.deepinfra.com/v1/openai/models",
				authorization: "Bearer deepinfra-test-key",
			},
		]);
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "deepseek-ai/DeepSeek-V3",
			provider: "deepinfra",
			api: "openai-completions",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.32, output: 0.89, cacheRead: 0.16 },
			contextWindow: 163840,
			maxTokens: 32768,
		});
	});
	test("accepts standard OpenAI model records without nested metadata", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "deepseek-ai/DeepSeek-V3", object: "model", owned_by: "deepinfra" },
						{ id: "unknown/model-without-standard-marker" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = deepinfraModelManagerOptions({ apiKey: "deepinfra-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(models?.map(model => model.id)).toEqual(["deepseek-ai/DeepSeek-V3"]);
		expect(models?.[0]).toMatchObject({
			id: "deepseek-ai/DeepSeek-V3",
			provider: "deepinfra",
			api: "openai-completions",
			baseUrl: "https://api.deepinfra.com/v1/openai",
		});
	});
});
