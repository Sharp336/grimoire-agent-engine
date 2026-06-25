import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { llmGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const MODELS_URL = "https://api.llmgateway.io/v1/models";

describe("llmgateway provider support", () => {
	test("registers built-in descriptor, default model, and catalog discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "llmgateway");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("gpt-5.5");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(descriptor?.catalogDiscovery).toEqual({
			label: "LLM Gateway",
			envVars: ["LLM_GATEWAY_API_KEY"],
			allowUnauthenticated: true,
		});
		expect(DEFAULT_MODEL_PER_PROVIDER.llmgateway).toBe("gpt-5.5");
		expect(descriptor?.createModelManagerOptions({ apiKey: "llmgtwy_TESTKEY" }).providerId).toBe("llmgateway");
	});

	test("bundles generated chat-capable LLM Gateway models", () => {
		const models = getBundledModels("llmgateway");
		expect(models.length).toBeGreaterThan(0);
		expect(models.some(model => model.id === "gpt-5.5")).toBe(true);
		expect(models.some(model => model.id === "auto" || model.id === "custom")).toBe(false);
		expect(models.some(model => /(?:tts|image|embed|embedding)/i.test(model.id))).toBe(false);
		expect(models.some(model => model.supportsTools === false)).toBe(false);
	});

	test("maps public LLM Gateway discovery shape into catalog metadata", async () => {
		let capturedUrl = "";
		let capturedAuth: string | null = null;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedAuth = new Headers(init?.headers).get("Authorization");
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "gpt-5.5",
							name: "GPT-5.5",
							architecture: { input_modalities: ["text", "image"] },
							pricing: {
								prompt: "5.0e-6",
								completion: "30.0e-6",
								input_cache_read: "0.5e-6",
								input_cache_write: "1.5e-6",
							},
							context_length: 1050000,
							providers: [{ reasoning: true, tools: true }],
							supported_parameters: ["tools"],
						},
						{
							id: "auto",
							name: "Auto Router",
							context_length: 0,
							providers: [{ tools: true }],
						},
						{
							id: "gpt-image-2",
							name: "GPT Image 2",
							architecture: { input_modalities: ["text"], output_modalities: ["image"] },
							context_length: 32000,
							providers: [{ tools: false }],
							supported_parameters: ["tools", "tool_choice"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = llmGatewayModelManagerOptions({ fetch: fetchMock });
		expect(options.providerId).toBe("llmgateway");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(capturedUrl).toBe(MODELS_URL);
		expect(capturedAuth).toBeNull();
		expect(models?.map(model => model.id)).toEqual(["gpt-5.5"]);

		const model = models?.[0];
		expect(model?.cost.input).toBe(5);
		expect(model?.cost.output).toBe(30);
		expect(model?.cost.cacheRead).toBe(0.5);
		expect(model?.cost.cacheWrite).toBe(1.5);
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.contextWindow).toBe(1050000);
		expect(model?.supportsTools).not.toBe(false);
	});
});
