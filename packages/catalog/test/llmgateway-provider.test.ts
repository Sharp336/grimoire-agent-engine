import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { llmgatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_BASE_URL = Bun.env.LLM_GATEWAY_BASE_URL;

function restoreLlmGatewayEnv(): void {
	if (ORIGINAL_BASE_URL === undefined) {
		delete Bun.env.LLM_GATEWAY_BASE_URL;
	} else {
		Bun.env.LLM_GATEWAY_BASE_URL = ORIGINAL_BASE_URL;
	}
}

afterEach(() => {
	restoreLlmGatewayEnv();
	vi.restoreAllMocks();
});

/** Trimmed-down rows in the shape of the LLM Gateway `/v1/models` response. */
const DISCOVERY_PAYLOAD = {
	data: [
		{
			// Gateway pseudo-entry: auto-routes to a concrete model, not selectable.
			id: "auto",
			name: "Auto Route",
			family: "llmgateway",
			architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
			providers: [{ providerId: "llmgateway", externalId: "auto", tools: true, reasoning: false }],
			pricing: { prompt: "0", completion: "0" },
			context_length: 0,
		},
		{
			// Non-chat SKU: image generation.
			id: "gpt-image-2",
			name: "GPT Image 2",
			family: "openai",
			architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
			providers: [{ providerId: "openai", externalId: "gpt-image-2", tools: true, reasoning: false }],
			pricing: { prompt: "5e-6", completion: "0" },
			context_length: 0,
		},
		{
			// No tool-capable mapping.
			id: "chat-only-model",
			name: "Chat Only",
			family: "test",
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
			providers: [{ providerId: "test", externalId: "chat-only-model", tools: false, reasoning: false }],
			pricing: { prompt: "1e-6", completion: "2e-6" },
			context_length: 8192,
		},
		{
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			family: "anthropic",
			architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
			providers: [
				{ providerId: "anthropic", externalId: "claude-opus-4-8", tools: true, reasoning: true },
				{ providerId: "amazon-bedrock", externalId: "us.anthropic.claude-opus-4-8", tools: true, reasoning: true },
			],
			pricing: {
				prompt: "5e-6",
				completion: "25e-6",
				input_cache_read: "0.5e-6",
				input_cache_write: "6.25e-6",
			},
			context_length: 200000,
		},
	],
};

function discoveryFetchMock(calls: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({ url: input.toString(), authorization: headers.get("authorization") });
		return new Response(JSON.stringify(DISCOVERY_PAYLOAD), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as FetchImpl;
}

describe("LLM Gateway provider support", () => {
	test("registers descriptor, default model, and environment key", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "llmgateway");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("claude-opus-4-8");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(descriptor?.catalogDiscovery?.label).toBe("LLM Gateway");
		expect(descriptor?.catalogDiscovery?.allowUnauthenticated).toBe(true);
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["LLM_GATEWAY_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.llmgateway).toBe("claude-opus-4-8");
	});

	test("discovers chat models and maps catalog metadata", async () => {
		delete Bun.env.LLM_GATEWAY_BASE_URL;
		const calls: Array<{ url: string; authorization: string | null }> = [];

		const options = llmgatewayModelManagerOptions({ apiKey: "llmgtwy_test", fetch: discoveryFetchMock(calls) });
		const models = await options.fetchDynamicModels?.();

		expect(options.providerId).toBe("llmgateway");
		expect(calls).toEqual([{ url: "https://api.llmgateway.io/v1/models", authorization: "Bearer llmgtwy_test" }]);

		// Pseudo-entries, non-text SKUs, and tool-less models are filtered out.
		expect(models?.map(model => model.id)).toEqual(["claude-opus-4-8"]);
		expect(models?.[0]).toMatchObject({
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			api: "openai-completions",
			provider: "llmgateway",
			baseUrl: "https://api.llmgateway.io/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		});
	});

	test("honors LLM_GATEWAY_BASE_URL for self-hosted deployments", async () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "http://localhost:4001/v1";
		const calls: Array<{ url: string; authorization: string | null }> = [];

		const options = llmgatewayModelManagerOptions({ apiKey: "llmgtwy_test", fetch: discoveryFetchMock(calls) });
		await options.fetchDynamicModels?.();

		expect(calls[0]?.url).toBe("http://localhost:4001/v1/models");
		expect(options.cacheProviderId).toStartWith("llmgateway:");
	});
});
