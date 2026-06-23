import { afterEach, describe, expect, test, vi } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	wandbModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Weights & Biases provider support", () => {
	test("registers descriptor, default model, environment key, and bundled models", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "wandb");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("openai/gpt-oss-120b");
		expect(descriptor?.catalogDiscovery?.label).toBe("Weights & Biases");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["WANDB_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.wandb).toBe("openai/gpt-oss-120b");

		const bundled = getBundledModels("wandb");
		expect(bundled.find(model => model.id === "openai/gpt-oss-120b")).toMatchObject({
			api: "openai-completions",
			provider: "wandb",
			baseUrl: "https://api.inference.wandb.ai/v1",
		});
	});

	test("discovers dynamic models from the W&B OpenAI-compatible models endpoint", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: input.toString(), authorization: headers.get("authorization") });
			return new Response(
				JSON.stringify({
					data: [{ id: "openai/gpt-oss-120b", name: "GPT OSS 120B" }, { id: "meta-llama/Llama-3.1-8B-Instruct" }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as FetchImpl;

		const options = wandbModelManagerOptions({ apiKey: "wandb-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(options.providerId).toBe("wandb");
		expect(calls).toEqual([
			{
				url: "https://api.inference.wandb.ai/v1/models",
				authorization: "Bearer wandb-test-key",
			},
		]);
		expect(models?.find(model => model.id === "openai/gpt-oss-120b")).toMatchObject({
			id: "openai/gpt-oss-120b",
			name: "GPT OSS 120B",
			api: "openai-completions",
			provider: "wandb",
			baseUrl: "https://api.inference.wandb.ai/v1",
		});
	});

	test("maps models.dev wandb metadata into OpenAI chat completions models", () => {
		const mapped = mapModelsDevToModels(
			{
				wandb: {
					models: {
						"openai/gpt-oss-120b": {
							id: "openai/gpt-oss-120b",
							name: "GPT OSS 120B",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text"] },
							limit: { context: 131072, output: 32768 },
							cost: { input: 0.15, output: 0.6 },
						},
					},
				},
			},
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		);

		expect(mapped.find(model => model.provider === "wandb")).toMatchObject({
			id: "openai/gpt-oss-120b",
			name: "GPT OSS 120B",
			api: "openai-completions",
			provider: "wandb",
			baseUrl: "https://api.inference.wandb.ai/v1",
			reasoning: true,
			contextWindow: 131072,
			maxTokens: 32768,
			cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		});
	});
});
