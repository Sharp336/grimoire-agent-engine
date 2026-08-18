import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { hyperModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_HYPER_API_KEY = Bun.env.HYPER_API_KEY;

afterEach(() => {
	if (ORIGINAL_HYPER_API_KEY === undefined) {
		delete Bun.env.HYPER_API_KEY;
	} else {
		Bun.env.HYPER_API_KEY = ORIGINAL_HYPER_API_KEY;
	}
	vi.restoreAllMocks();
});

/** One entry in Hyper's `/v1/models` OpenAI-surface response shape. */
function hyperModelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data: entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Charm Hyper provider support", () => {
	test("resolves the HYPER_API_KEY environment fallback", () => {
		Bun.env.HYPER_API_KEY = "sk-hyper-test-key";
		expect(getEnvApiKey("charm-hyper")).toBe("sk-hyper-test-key");
	});

	test("registers descriptor, default model, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "charm-hyper");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-v4-pro");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["charm-hyper"]).toBe("deepseek-v4-pro");

		const provider = getOAuthProviders().find(item => item.id === "charm-hyper");
		expect(provider?.name).toBe("Charm Hyper");
	});

	test("maps Hyper /v1/models metadata: context, vision, efforts, and pricing", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			hyperModelsResponse([
				{
					id: "deepseek-v4-pro",
					display_name: "DeepSeek V4 Pro",
					context_window: 1000000,
					max_output_tokens: 384000,
					capabilities: { vision: false },
					reasoning: {
						effort_levels: [
							{ value: "high", display: "High" },
							{ value: "xhigh", display: "X-High" },
						],
						default_effort_level: "high",
					},
					pricing: { input: 2.4, output: 4.8, cache_create: 0, cache_hit: 0.2 },
				},
				{
					id: "kimi-k2.7-code",
					display_name: "Kimi K2.7 Code",
					context_window: 256000,
					max_output_tokens: 16000,
					capabilities: { vision: true },
					pricing: { input: 0.95, output: 4, cache_create: 0, cache_hit: 0.19 },
				},
			]),
		) as unknown as FetchImpl;

		const options = hyperModelManagerOptions({ apiKey: "sk-hyper-test-key", fetch: fetchMock });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://hyper.charm.land/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer sk-hyper-test-key" }),
			}),
		);

		const deepseek = models?.find(model => model.id === "deepseek-v4-pro");
		expect(deepseek?.name).toBe("DeepSeek V4 Pro");
		expect(deepseek?.reasoning).toBe(true);
		expect(deepseek?.thinking?.efforts).toEqual([Effort.High, Effort.XHigh]);
		expect(deepseek?.thinking?.defaultLevel).toBe(Effort.High);
		expect(deepseek?.contextWindow).toBe(1000000);
		expect(deepseek?.maxTokens).toBe(384000);
		expect(deepseek?.input).toEqual(["text"]);
		expect(deepseek?.cost).toEqual({ input: 2.4, output: 4.8, cacheRead: 0.2, cacheWrite: 0 });

		const kimi = models?.find(model => model.id === "kimi-k2.7-code");
		expect(kimi?.reasoning).toBe(false);
		expect(kimi?.thinking).toBeUndefined();
		expect(kimi?.input).toEqual(["text", "image"]);
		expect(kimi?.cost).toEqual({ input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 });
	});

	test("normalizes base URLs to the /v1 prefix", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			hyperModelsResponse([{ id: "deepseek-v4-pro" }]),
		) as unknown as FetchImpl;

		const options = hyperModelManagerOptions({
			apiKey: "sk-hyper-test-key",
			baseUrl: "https://hyper.charm.land/",
			fetch: fetchMock,
		});
		await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://hyper.charm.land/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
	});
});
