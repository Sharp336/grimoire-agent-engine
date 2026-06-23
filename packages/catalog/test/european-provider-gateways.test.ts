import { afterEach, describe, expect, test, vi } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	cortecsModelManagerOptions,
	EUROPEAN_GATEWAY_STATIC_MODELS,
	eurouterModelManagerOptions,
	meliousModelManagerOptions,
	nebiusModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const providerCases = [
	{
		id: "melious",
		defaultModel: "gpt-oss-120b",
		envVar: "MELIOUS_API_KEY",
		baseUrl: "https://api.melious.ai/v1",
		manager: meliousModelManagerOptions,
	},
	{
		id: "nebius",
		defaultModel: "deepseek-ai/DeepSeek-R1-0528",
		envVar: "NEBIUS_API_KEY",
		baseUrl: "https://api.tokenfactory.nebius.com/v1",
		manager: nebiusModelManagerOptions,
	},
	{
		id: "cortecs",
		defaultModel: "gpt-oss-120b",
		envVar: "CORTECS_API_KEY",
		baseUrl: "https://api.cortecs.ai/v1",
		manager: cortecsModelManagerOptions,
	},
	{
		id: "eurouter",
		defaultModel: "mistral-large-3",
		envVar: "EUROUTER_API_KEY",
		baseUrl: "https://api.eurouter.ai/api/v1",
		manager: eurouterModelManagerOptions,
	},
] as const;

const originalEnv = new Map<string, string | undefined>(
	providerCases.map(provider => [provider.envVar, Bun.env[provider.envVar]]),
);

afterEach(() => {
	for (const [key, value] of originalEnv) {
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	vi.restoreAllMocks();
});

describe("European gateway provider catalog support", () => {
	for (const provider of providerCases) {
		test(`registers ${provider.id} descriptor, default model, and env var`, () => {
			Bun.env[provider.envVar] = `${provider.id}-test-key`;

			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === provider.id);
			expect(descriptor).toBeDefined();
			expect(descriptor?.defaultModel).toBe(provider.defaultModel);
			expect(descriptor?.catalogDiscovery?.envVars).toContain(provider.envVar);
			expect((DEFAULT_MODEL_PER_PROVIDER as Record<string, string>)[provider.id]).toBe(provider.defaultModel);
			expect(getEnvApiKey(provider.id)).toBe(`${provider.id}-test-key`);
		});

		test(`${provider.id} discovers models from its documented OpenAI-compatible endpoint`, async () => {
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				expect(url).toBe(`${provider.baseUrl}/models`);
				expect(init?.method).toBe("GET");
				expect(init?.headers).toEqual({
					Accept: "application/json",
					Authorization: `Bearer ${provider.id}-test-key`,
				});
				return new Response(
					JSON.stringify({
						data: [
							{
								id: provider.defaultModel,
								name: provider.defaultModel,
								context_length: 131000,
								max_completion_tokens: 8192,
								supported_parameters: ["tools"],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const options = provider.manager({ apiKey: `${provider.id}-test-key`, fetch: fetchMock });
			expect(options.providerId).toBe(provider.id);
			expect(options.fetchDynamicModels).toBeDefined();

			const models = await options.fetchDynamicModels?.();
			expect(models?.[0]).toMatchObject({
				id: provider.defaultModel,
				api: "openai-completions",
				provider: provider.id,
				baseUrl: provider.baseUrl,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	}

	test("ships curated fallback model seeds for keyless catalog regeneration", () => {
		for (const provider of providerCases) {
			expect(EUROPEAN_GATEWAY_STATIC_MODELS).toContainEqual(
				expect.objectContaining({
					id: provider.defaultModel,
					provider: provider.id,
					baseUrl: provider.baseUrl,
				}),
			);
		}
	});
});
