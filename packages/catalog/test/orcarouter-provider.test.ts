import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	isOrcaRouterChatModelEntry,
	ORCAROUTER_STATIC_MODELS,
	orcarouterModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_ORCAROUTER_API_KEY = Bun.env.ORCAROUTER_API_KEY;

afterEach(() => {
	if (ORIGINAL_ORCAROUTER_API_KEY === undefined) {
		delete Bun.env.ORCAROUTER_API_KEY;
	} else {
		Bun.env.ORCAROUTER_API_KEY = ORIGINAL_ORCAROUTER_API_KEY;
	}
	vi.restoreAllMocks();
});

/** OrcaRouter's `/v1/models` response shape. */
function orcarouterModelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data: entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("OrcaRouter provider support", () => {
	test("resolves the ORCAROUTER_API_KEY environment fallback", () => {
		Bun.env.ORCAROUTER_API_KEY = "orcarouter-test-key";
		expect(getEnvApiKey("orcarouter")).toBe("orcarouter-test-key");
	});

	test("registers descriptor, default model, bundled seed, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "orcarouter");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("anthropic/claude-opus-4.8");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.orcarouter).toBe("anthropic/claude-opus-4.8");

		// Without the seed, a regen that cannot reach the gateway bundles no
		// orcarouter models and the declared defaultModel is unresolvable at
		// boot, before async discovery fires.
		expect(ORCAROUTER_STATIC_MODELS.map(model => model.id)).toContain("anthropic/claude-opus-4.8");
		const bundled = getBundledModels("orcarouter");
		expect(bundled.find(model => model.id === "anthropic/claude-opus-4.8")).toBeDefined();
		for (const model of bundled) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.orcarouter.ai/v1");
		}

		const provider = getOAuthProviders().find(item => item.id === "orcarouter");
		expect(provider?.name).toBe("OrcaRouter");
	});

	test("keeps chat-capable entries and drops endpoints this dialect cannot drive", () => {
		expect(isOrcaRouterChatModelEntry({ id: "openai/gpt-5.5", supported_endpoint_types: ["openai"] })).toBe(true);
		expect(
			isOrcaRouterChatModelEntry({
				id: "anthropic/claude-opus-4.8",
				supported_endpoint_types: ["anthropic", "openai", "openai-response"],
			}),
		).toBe(true);
		// Unspecified means "unknown", not "unusable": several chat models ship
		// with an empty list and must stay selectable.
		expect(isOrcaRouterChatModelEntry({ id: "google/gemma-4-31b-it", supported_endpoint_types: [] })).toBe(true);
		expect(isOrcaRouterChatModelEntry({ id: "qwen/qwen3-vl-235b-a22b-instruct" })).toBe(true);

		expect(
			isOrcaRouterChatModelEntry({ id: "openai/text-embedding-3-small", supported_endpoint_types: ["embeddings"] }),
		).toBe(false);
		expect(
			isOrcaRouterChatModelEntry({ id: "openai/gpt-image-1", supported_endpoint_types: ["image-generation"] }),
		).toBe(false);
		expect(isOrcaRouterChatModelEntry({ id: "kling/kling-v3", supported_endpoint_types: ["openai-video"] })).toBe(
			false,
		);
		expect(
			isOrcaRouterChatModelEntry({ id: "google/gemini-3-pro-image-preview", supported_endpoint_types: ["gemini"] }),
		).toBe(false);
	});

	test("maps OrcaRouter /v1/models metadata: per-million pricing, context, and modalities", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			orcarouterModelsResponse([
				{
					id: "anthropic/claude-opus-4.8",
					name: "Anthropic: Claude Opus 4.8",
					supported_endpoint_types: ["anthropic", "openai"],
					context_length: 1000000,
					max_completion_tokens: 128000,
					architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
					pricing: {
						prompt: "0.0000050000",
						completion: "0.0000250000",
						prompt_per_million: 5,
						completion_per_million: 25,
					},
				},
				{
					id: "openai/text-embedding-3-small",
					supported_endpoint_types: ["embeddings"],
				},
			]),
		) as unknown as FetchImpl;

		const options = orcarouterModelManagerOptions({ apiKey: "orcarouter-key", fetch: fetchMock });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.orcarouter.ai/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer orcarouter-key" }),
			}),
		);

		expect(models?.map(model => model.id)).toEqual(["anthropic/claude-opus-4.8"]);
		const opus = models?.[0];
		expect(opus?.api).toBe("openai-completions");
		expect(opus?.provider).toBe("orcarouter");
		expect(opus?.baseUrl).toBe("https://api.orcarouter.ai/v1");
		// `prompt_per_million` is already per-million, so it needs no unit
		// conversion the way OpenRouter's per-token `pricing.prompt` does.
		expect(opus?.cost).toMatchObject({ input: 5, output: 25 });
		expect(opus?.contextWindow).toBe(1000000);
		expect(opus?.maxTokens).toBe(128000);
		// `file` is not part of the ModelSpec input vocabulary and is dropped.
		expect(opus?.input).toEqual(["text", "image"]);
		// Upstream-namespaced ids let the cross-provider reference index supply
		// reasoning/thinking for a model the bundle already knows.
		expect(opus?.reasoning).toBe(true);
	});

	test("discovers models without a key because /v1/models is public", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			orcarouterModelsResponse([{ id: "openai/gpt-5.5", supported_endpoint_types: ["openai"] }]),
		) as unknown as FetchImpl;

		const options = orcarouterModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["openai/gpt-5.5"]);
		const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
	});

	test("honors an explicit base URL override", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			orcarouterModelsResponse([{ id: "openai/gpt-5.5" }]),
		) as unknown as FetchImpl;

		const options = orcarouterModelManagerOptions({
			baseUrl: "https://gateway.orcarouter.test/v1/",
			fetch: fetchMock,
		});
		await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://gateway.orcarouter.test/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
	});
});
