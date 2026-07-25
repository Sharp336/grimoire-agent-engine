import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { llmGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { getCatalogProviderEntry } from "@oh-my-pi/pi-catalog/provider-models/descriptors";

describe("LLM Gateway provider catalog", () => {
	it("bundles chat models with correct provider and baseUrl", () => {
		const models = getBundledModels("llmgateway");
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			expect(model.provider).toBe("llmgateway");
			expect(model.api).toBe("openai-completions");
		}
	});

	it("bundles gpt-4o as default model", () => {
		const model = getBundledModel("llmgateway", "gpt-4o");
		expect(model).toBeDefined();
		expect(model.provider).toBe("llmgateway");
	});

	it("does not bundle embedding models", () => {
		const models = getBundledModels("llmgateway");
		const embeddingModels = models.filter(m => m.id.includes("embedding") || m.id.includes("embed"));
		expect(embeddingModels).toEqual([]);
	});

	it("does not bundle TTS/audio models", () => {
		const models = getBundledModels("llmgateway");
		const ttsModels = models.filter(m => m.id.includes("tts") || m.id.includes("audio") || m.id.includes("whisper"));
		expect(ttsModels).toEqual([]);
	});

	it("does not bundle image-generation-only models", () => {
		const models = getBundledModels("llmgateway");
		const imageModels = models.filter(
			m => m.id.includes("dall-e") || m.id.includes("dalle") || m.id.includes("flux"),
		);
		expect(imageModels).toEqual([]);
	});
});

describe("LLM Gateway runtime discovery", () => {
	it("fetches from the hosted API by default", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "gpt-4o",
							name: "GPT-4o",
							architecture: { output_modalities: ["text"] },
							providers: [{ providerId: "openai", tools: true }],
						},
						{
							id: "text-embedding-3-small",
							name: "Text Embedding 3 Small",
							architecture: { output_modalities: ["embedding"] },
							providers: [{ providerId: "openai", tools: false }],
						},
						{
							id: "tts-1",
							name: "TTS-1",
							architecture: { output_modalities: ["audio"] },
							providers: [{ providerId: "openai", tools: false }],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = llmGatewayModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["https://api.llmgateway.io/v1/models"]);
		expect(models).toBeDefined();
		expect(models!.length).toBe(1);
		expect(models![0].id).toBe("gpt-4o");
	});

	it("filters out non-chat models based on architecture.output_modalities", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "claude-sonnet-4",
							architecture: { output_modalities: ["text"] },
							providers: [{ tools: true }],
						},
						{
							id: "text-embedding-3-large",
							architecture: { output_modalities: ["embedding"] },
							providers: [{ tools: false }],
						},
						{
							id: "gpt-image-2",
							architecture: { output_modalities: ["image"] },
							providers: [{ tools: false }],
						},
						{
							id: "gemini-2.5-flash",
							architecture: { output_modalities: ["text", "image"] },
							providers: [{ tools: true }],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = llmGatewayModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		const ids = models!.map(m => m.id);
		expect(ids).toContain("claude-sonnet-4");
		expect(ids).toContain("gemini-2.5-flash"); // text+image output is chat-capable
		expect(ids).not.toContain("text-embedding-3-large");
		expect(ids).not.toContain("gpt-image-2");
	});

	it("includes models without architecture metadata (fallback to include)", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "unknown-new-model",
							// no architecture field
							providers: [{ tools: true }],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = llmGatewayModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models!.length).toBe(1);
		expect(models![0].id).toBe("unknown-new-model");
	});

	it("does not disable tools on discovered models (supportsTools unset = supported)", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "gpt-4o",
							architecture: { output_modalities: ["text"] },
							providers: [{ tools: true }],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = llmGatewayModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		// supportsTools is undefined (default = tools supported), not explicitly false
		expect(models![0].supportsTools).toBeUndefined();
	});

	it("keeps text models with all-providers-tools-false as supportsTools:false", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "non-tool-chat-model",
							architecture: { output_modalities: ["text", "image"] },
							providers: [{ tools: false }],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = llmGatewayModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models!.length).toBe(1);
		expect(models![0].supportsTools).toBe(false);
	});

	it("includes models where at least one provider has tools: true", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "chat-model",
							architecture: { output_modalities: ["text"] },
							providers: [{ tools: false }, { tools: true }],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = llmGatewayModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();

		expect(models).toBeDefined();
		expect(models!.length).toBe(1);
		expect(models![0].supportsTools).toBeUndefined();
	});
});

describe("LLM Gateway self-hosted (on-prem)", () => {
	const originalEnv = { ...Bun.env };

	afterEach(() => {
		// Restore env
		for (const key of Object.keys(Bun.env)) {
			if (key.startsWith("LLM_GATEWAY")) {
				delete Bun.env[key];
			}
		}
		for (const [key, val] of Object.entries(originalEnv)) {
			if (key.startsWith("LLM_GATEWAY") && val !== undefined) {
				Bun.env[key] = val;
			}
		}
	});

	it("uses LLM_GATEWAY_BASE_URL env var over the default", async () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "http://my-gateway.local:8000/v1";
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				JSON.stringify({ data: [{ id: "local-model", architecture: { output_modalities: ["text"] } }] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		// Pass bundled default as baseUrl (simulates coding-agent)
		const options = llmGatewayModelManagerOptions({
			apiKey: "local-key",
			baseUrl: "https://api.llmgateway.io/v1",
			fetch: fetchImpl,
		});
		await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["http://my-gateway.local:8000/v1/models"]);
	});

	it("uses config.baseUrl when LLM_GATEWAY_BASE_URL is not set", async () => {
		delete Bun.env.LLM_GATEWAY_BASE_URL;
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				JSON.stringify({ data: [{ id: "custom-model", architecture: { output_modalities: ["text"] } }] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = llmGatewayModelManagerOptions({
			apiKey: "test-key",
			baseUrl: "https://custom.gateway.io/v1",
			fetch: fetchImpl,
		});
		await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["https://custom.gateway.io/v1/models"]);
	});

	it("config.baseUrl wins over LLM_GATEWAY_BASE_URL env var", async () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "http://env-should-lose:9000/v1";
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const options = llmGatewayModelManagerOptions({
			apiKey: "test-key",
			baseUrl: "https://config-wins.io/v1",
			fetch: fetchImpl,
		});
		await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["https://config-wins.io/v1/models"]);
	});
	it("env var wins when config.baseUrl is the bundled default", async () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "http://env-wins:9000/v1";
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		// Simulate registry passing the bundled default as config.baseUrl
		const options = llmGatewayModelManagerOptions({
			apiKey: "test-key",
			baseUrl: "https://api.llmgateway.io/v1",
			fetch: fetchImpl,
		});
		await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["http://env-wins:9000/v1/models"]);
	});

	it("always returns fetchDynamicModels (even without API key)", () => {
		const options = llmGatewayModelManagerOptions({});
		expect(options.fetchDynamicModels).toBeDefined();
	});

	it("is marked dynamicModelsAuthoritative", () => {
		const options = llmGatewayModelManagerOptions({ apiKey: "test" });
		expect(options.dynamicModelsAuthoritative).toBe(true);
	});
});
describe("LLM Gateway env base URL override", () => {
	const origEnv = Bun.env.LLM_GATEWAY_BASE_URL;
	const BUNDLED_DEFAULT = "https://api.llmgateway.io/v1";
	afterEach(() => {
		if (origEnv == null) delete Bun.env.LLM_GATEWAY_BASE_URL;
		else Bun.env.LLM_GATEWAY_BASE_URL = origEnv;
	});

	it("ignores env var when config.baseUrl is absent (generator case)", () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "https://my-gateway.example/v1";
		const options = llmGatewayModelManagerOptions({ apiKey: "test" });
		// Generator passes no baseUrl — env var must not leak into catalog
		expect(options.staticModels).toBeUndefined();
	});

	it("applies env var via staticModels when config.baseUrl is the bundled default", () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "https://my-gateway.example/v1";
		const options = llmGatewayModelManagerOptions({ apiKey: "test", baseUrl: BUNDLED_DEFAULT });
		expect(options.staticModels).toBeDefined();
		const models = options.staticModels!;
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.baseUrl).toBe("https://my-gateway.example/v1");
		}
	});

	it("does not set staticModels when env var is absent", () => {
		delete Bun.env.LLM_GATEWAY_BASE_URL;
		const options = llmGatewayModelManagerOptions({ apiKey: "test", baseUrl: BUNDLED_DEFAULT });
		expect(options.staticModels).toBeUndefined();
	});

	it("does not patch when config.baseUrl is explicitly different from bundled", () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "https://env-gateway.example/v1";
		const options = llmGatewayModelManagerOptions({
			apiKey: "test",
			baseUrl: "https://explicit-gateway.example/v1",
		});
		expect(options.staticModels).toBeUndefined();
	});
});
describe("LLM Gateway cache keying", () => {
	it("cacheProviderId varies by base URL", () => {
		const defaultOpts = llmGatewayModelManagerOptions({ apiKey: "test" });
		const customOpts = llmGatewayModelManagerOptions({
			apiKey: "test",
			baseUrl: "https://custom-gateway.example/v1",
		});
		expect(defaultOpts.cacheProviderId).toBeDefined();
		expect(customOpts.cacheProviderId).toBeDefined();
		expect(defaultOpts.cacheProviderId).not.toBe(customOpts.cacheProviderId);
	});
});

describe("LLM Gateway image-only name-pattern exclusion", () => {
	it("excludes cogview and seedream by name pattern at runtime", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "cogview-4", architecture: { output_modalities: ["text", "image"] }, providers: [{ tools: false }] },
						{ id: "seedream-5-0-pro", architecture: { output_modalities: ["text", "image"] }, providers: [{ tools: false }] },
						{ id: "gpt-4o", architecture: { output_modalities: ["text"] }, providers: [{ tools: true }] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		const options = llmGatewayModelManagerOptions({ apiKey: "test", baseUrl: "https://api.llmgateway.io/v1", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();
		expect(models).toBeDefined();
		const ids = models!.map(m => m.id);
		expect(ids).toContain("gpt-4o");
		expect(ids).not.toContain("cogview-4");
		expect(ids).not.toContain("seedream-5-0-pro");
	});
});

describe("LLM Gateway resolveBaseUrl descriptor", () => {
	const origEnv = Bun.env.LLM_GATEWAY_BASE_URL;
	afterEach(() => {
		if (origEnv == null) delete Bun.env.LLM_GATEWAY_BASE_URL;
		else Bun.env.LLM_GATEWAY_BASE_URL = origEnv;
	});

	it("returns env var when bundled URL matches default", () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "https://self-hosted.example/v1";
		const entry = getCatalogProviderEntry("llmgateway");
		expect(entry?.resolveBaseUrl).toBeDefined();
		const resolved = entry!.resolveBaseUrl!("https://api.llmgateway.io/v1");
		expect(resolved).toBe("https://self-hosted.example/v1");
	});

	it("returns bundled URL when env var is absent", () => {
		delete Bun.env.LLM_GATEWAY_BASE_URL;
		const entry = getCatalogProviderEntry("llmgateway");
		const resolved = entry!.resolveBaseUrl!("https://api.llmgateway.io/v1");
		expect(resolved).toBe("https://api.llmgateway.io/v1");
	});

	it("preserves explicit non-default bundled URL over env var", () => {
		Bun.env.LLM_GATEWAY_BASE_URL = "https://self-hosted.example/v1";
		const entry = getCatalogProviderEntry("llmgateway");
		const resolved = entry!.resolveBaseUrl!("https://custom-proxy.example/v1");
		expect(resolved).toBe("https://custom-proxy.example/v1");
	});

	it("returns undefined when no bundled URL and no env var", () => {
		delete Bun.env.LLM_GATEWAY_BASE_URL;
		const entry = getCatalogProviderEntry("llmgateway");
		const resolved = entry!.resolveBaseUrl!(undefined);
		expect(resolved).toBeUndefined();
	});
});
