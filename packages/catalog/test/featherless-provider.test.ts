import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	getCatalogProviderEntry,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { featherlessModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Featherless provider support", () => {
	test("registers descriptor and static fallback for OpenAI-compatible chat completions", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "featherless");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("zai-org/GLM-5.2");
		expect(getCatalogProviderEntry("featherless")?.envVars).toEqual(["FEATHERLESS_API_KEY"]);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.featherless).toBe("zai-org/GLM-5.2");

		const options = featherlessModelManagerOptions();
		expect(options.providerId).toBe("featherless");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels?.find(model => model.id === "zai-org/GLM-5.2")).toMatchObject({
			id: "zai-org/GLM-5.2",
			name: "zai-org/GLM-5.2",
			api: "openai-completions",
			provider: "featherless",
			baseUrl: "https://api.featherless.ai/v1",
			supportsTools: true,
			contextWindow: 262_144,
			maxTokens: null,
		});
	});

	test("discovers only plan-available tool-use models and preserves Featherless limits", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: input.toString(),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "zai-org/GLM-5.2",
							name: "GLM 5.2",
							features: { tool_use: true },
							context_length: 262_144,
							max_completion_tokens: 65_536,
						},
						{
							id: "vendor/tool-model-without-plan-flag",
							features: { tool_use: true },
							context_length: 131_072,
							max_completion_tokens: 32_768,
						},
						{
							id: "vendor/text-only-model",
							features: { tool_use: false },
							context_length: 65_536,
							max_completion_tokens: 16_384,
						},
						{
							id: "vendor/unavailable-tool-model",
							features: { tool_use: true },
							available_on_current_plan: false,
							context_length: 65_536,
							max_completion_tokens: 16_384,
						},
						{
							id: "vendor/missing-feature-metadata",
							context_length: 65_536,
							max_completion_tokens: 16_384,
						},
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as FetchImpl;

		const options = featherlessModelManagerOptions({ apiKey: "featherless-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.featherless.ai/v1/models",
				authorization: "Bearer featherless-test-key",
			},
		]);
		expect(models?.map(model => model.id)).toEqual(["vendor/tool-model-without-plan-flag", "zai-org/GLM-5.2"]);
		expect(models?.find(model => model.id === "zai-org/GLM-5.2")).toMatchObject({
			id: "zai-org/GLM-5.2",
			name: "GLM 5.2",
			api: "openai-completions",
			provider: "featherless",
			baseUrl: "https://api.featherless.ai/v1",
			supportsTools: true,
			contextWindow: 262_144,
			maxTokens: 65_536,
		});
		expect(models?.find(model => model.id === "vendor/tool-model-without-plan-flag")).toMatchObject({
			provider: "featherless",
			baseUrl: "https://api.featherless.ai/v1",
			supportsTools: true,
			contextWindow: 131_072,
			maxTokens: 32_768,
		});
	});
});
