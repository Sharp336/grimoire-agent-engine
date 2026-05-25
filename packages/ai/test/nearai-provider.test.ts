import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { nearAiModelManagerOptions } from "../src/provider-models/openai-compat";
import { resolveOpenAICompat } from "../src/providers/openai-completions-compat";
import { getEnvApiKey } from "../src/stream";
import type { Model } from "../src/types";
import { getOAuthProviders } from "../src/utils/oauth";

const originalNearAiApiKey = Bun.env.NEARAI_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalNearAiApiKey === undefined) {
		delete Bun.env.NEARAI_API_KEY;
	} else {
		Bun.env.NEARAI_API_KEY = originalNearAiApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("nearai provider support", () => {
	test("resolves NEARAI_API_KEY from environment", () => {
		Bun.env.NEARAI_API_KEY = "nearai-test-key";
		expect(getEnvApiKey("nearai")).toBe("nearai-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "nearai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("zai-org/GLM-5.1-FP8");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("NEARAI_API_KEY");
		expect(descriptor?.catalogDiscovery?.allowUnauthenticated).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.nearai).toBe("zai-org/GLM-5.1-FP8");
	});

	test("registers NEAR AI Cloud in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "nearai");
		expect(provider?.name).toBe("NEAR AI Cloud");
	});

	test("maps NEAR AI Cloud catalog models and filters non-chat entries", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								modelId: "zai-org/GLM-5.1-FP8",
								inputCostPerToken: { amount: 1000, scale: 9, currency: "USD" },
								outputCostPerToken: { amount: 3000, scale: 9, currency: "USD" },
								cacheReadCostPerToken: { amount: 100, scale: 9, currency: "USD" },
								metadata: {
									contextLength: 202752,
									modelDisplayName: "GLM 5.1",
									architecture: { inputModalities: ["text"], outputModalities: ["text"] },
									verifiable: true,
									attestationSupported: true,
								},
							},
							{
								modelId: "Qwen/Qwen3-VL-30B-A3B-Instruct",
								inputCostPerToken: { amount: 500, scale: 9, currency: "USD" },
								outputCostPerToken: { amount: 1500, scale: 9, currency: "USD" },
								metadata: {
									contextLength: 256000,
									architecture: { inputModalities: ["text", "image"], outputModalities: ["text"] },
								},
							},
							{
								modelId: "Qwen/Qwen3-Reranker-0.6B",
								metadata: {
									contextLength: 40960,
									architecture: { inputModalities: ["text"], outputModalities: ["text"] },
								},
							},
							{
								modelId: "black-forest-labs/FLUX.2-klein-4B",
								metadata: {
									contextLength: 128000,
									architecture: { inputModalities: ["text"], outputModalities: ["image"] },
								},
							},
							{
								modelId: "openai/whisper-large-v3",
								metadata: {
									contextLength: 448,
									architecture: { inputModalities: ["audio"], outputModalities: ["text"] },
								},
							},
							{
								modelId: "openai/privacy-filter",
								metadata: {
									contextLength: 512,
									architecture: { inputModalities: ["text"], outputModalities: ["text"] },
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = nearAiModelManagerOptions();
		expect(options.providerId).toBe("nearai");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://cloud-api.near.ai/v1/model/list",
			expect.objectContaining({ method: "GET" }),
		);
		expect(models?.map(model => model.id)).toEqual(["Qwen/Qwen3-VL-30B-A3B-Instruct", "zai-org/GLM-5.1-FP8"]);

		const glm = models?.find(model => model.id === "zai-org/GLM-5.1-FP8");
		expect(glm?.name).toBe("GLM 5.1");
		expect(glm?.api).toBe("openai-completions");
		expect(glm?.provider).toBe("nearai");
		expect(glm?.baseUrl).toBe("https://cloud-api.near.ai/v1");
		expect(glm?.cost).toEqual({ input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 });
		expect(glm?.contextWindow).toBe(202752);
		expect(glm?.maxTokens).toBe(8192);
		expect(glm?.compat?.maxTokensField).toBe("max_tokens");

		const vision = models?.find(model => model.id === "Qwen/Qwen3-VL-30B-A3B-Instruct");
		expect(vision?.input).toEqual(["text", "image"]);
	});

	test("uses NEAR AI OpenAI-compatible request defaults", () => {
		const model: Model<"openai-completions"> = {
			id: "zai-org/GLM-5.1-FP8",
			name: "GLM 5.1",
			api: "openai-completions",
			provider: "nearai",
			baseUrl: "https://cloud-api.near.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 202752,
			maxTokens: 8192,
		};

		const compat = resolveOpenAICompat(model);
		expect(compat.supportsStore).toBe(false);
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.supportsUsageInStreaming).toBe(false);
		expect(compat.supportsStrictMode).toBe(false);
		expect(compat.maxTokensField).toBe("max_tokens");
	});
});
