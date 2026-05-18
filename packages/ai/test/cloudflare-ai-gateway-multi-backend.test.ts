import { describe, expect, it } from "bun:test";
import { cloudflareAiGatewayModelManagerOptions } from "@oh-my-pi/pi-ai/provider-models/openai-compat";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";

describe("cloudflareAiGatewayModelManagerOptions: prefix-aware routing", () => {
	const options = cloudflareAiGatewayModelManagerOptions({
		apiKey: "cf-gateway-token",
		baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic", // legacy form
	});

	it("returns providerId 'cloudflare-ai-gateway'", () => {
		expect(options.providerId).toBe("cloudflare-ai-gateway");
	});

	it("provides static models with prefix-aware api + baseUrl", () => {
		const staticModels = options.staticModels ?? [];
		expect(staticModels.length).toBeGreaterThan(0);

		const anthropic = staticModels.find(m => m.id === "anthropic/claude-sonnet-4-5");
		expect(anthropic?.api).toBe("anthropic-messages");
		expect(anthropic?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic");

		const workersAi = staticModels.find(m => m.id === "workers-ai/@cf/moonshotai/kimi-k2.6");
		expect(workersAi?.api).toBe("openai-completions");
		expect(workersAi?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1");

		const openai = staticModels.find(m => m.id.startsWith("openai/"));
		expect(openai?.api).toBe("openai-completions");
		expect(openai?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/openai/v1");
	});

	it("accepts the bare gateway base URL (no suffix) and routes correctly", () => {
		const bareOptions = cloudflareAiGatewayModelManagerOptions({
			apiKey: "cf-gateway-token",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw",
		});
		const workersAi = (bareOptions.staticModels ?? []).find(m => m.id === "workers-ai/@cf/moonshotai/kimi-k2.6");
		expect(workersAi?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1");
	});

	it("falls back to a placeholder base when no baseUrl is configured", () => {
		const placeholderOptions = cloudflareAiGatewayModelManagerOptions({});
		const anthropic = (placeholderOptions.staticModels ?? []).find(m => m.id === "anthropic/claude-sonnet-4-5");
		// Default placeholder per the existing CLOUDFLARE_AI_GATEWAY_BASE_URL doc convention.
		expect(anthropic?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic");
	});
});

describe("workers-ai backend request shape", () => {
	function makeSseResponse(modelId: string): Response {
		const chunks = [
			JSON.stringify({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: modelId,
				choices: [{ index: 0, delta: { content: "hi" } }],
			}),
			JSON.stringify({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: modelId,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
			"[DONE]",
		];
		const payload = `${chunks.map(c => `data: ${c}`).join("\n\n")}\n\n`;
		return new Response(payload, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it("routes a workers-ai request to /workers-ai/v1/chat/completions with cf-aig-authorization", async () => {
		const options = cloudflareAiGatewayModelManagerOptions({
			apiKey: "cf-gateway-token",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw",
		});
		const kimi = (options.staticModels ?? []).find(m => m.id === "workers-ai/@cf/moonshotai/kimi-k2.6");
		if (!kimi) throw new Error("kimi-k2.6 missing from bundled CF AI Gateway models");

		const captured: { url?: string; headers?: Record<string, string> } = {};
		const fakeFetch: FetchImpl = async (input, init) => {
			captured.url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			const headers = new Headers(init?.headers);
			captured.headers = Object.fromEntries(headers.entries());
			return makeSseResponse(kimi.id);
		};

		const context: Context = {
			systemPrompt: ["hi"],
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		await streamOpenAICompletions(kimi as Model<"openai-completions">, context, {
			apiKey: "cf-gateway-token",
			fetch: fakeFetch,
		}).result();

		expect(captured.url).toContain("/v1/acc/gw/workers-ai/v1/chat/completions");
		expect(captured.headers?.["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
		// Authorization must not leak the CF gateway token to the upstream provider.
		expect(captured.headers?.authorization ?? "").not.toContain("cf-gateway-token");
	});
});

describe("anthropic backend regression", () => {
	it("keeps anthropic/* models on anthropic-messages with /anthropic baseUrl", () => {
		const options = cloudflareAiGatewayModelManagerOptions({
			apiKey: "cf-gateway-token",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw",
		});
		const claude = (options.staticModels ?? []).find(m => m.id === "anthropic/claude-sonnet-4-5");
		expect(claude?.api).toBe("anthropic-messages");
		expect(claude?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic");
	});

	it("falls back to anthropic-messages for the legacy bare claude-sonnet-4-5 entry", () => {
		const options = cloudflareAiGatewayModelManagerOptions({
			apiKey: "cf-gateway-token",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw",
		});
		const bare = (options.staticModels ?? []).find(m => m.id === "claude-sonnet-4-5");
		// Only present in the pre-correction bundle; after Task 7's regen, the bare
		// entry may be removed by the generator. Skip if absent.
		if (!bare) return;
		expect(bare?.api).toBe("anthropic-messages");
		expect(bare?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic");
	});
});
