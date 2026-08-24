import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { mergeDiscoveredModel } from "@oh-my-pi/pi-coding-agent/config/model-registry";

function commandCodeModel(api: Api, baseUrl: string): Model<Api> {
	return buildModel({
		id: api === "anthropic-messages" ? "claude-opus-4-8" : "gpt-5.5",
		name: "Command Code test model",
		api,
		provider: "command-code",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

describe("Command Code discovery merge", () => {
	test("normalizes a /v1 provider override for Anthropic models", () => {
		const discovered = commandCodeModel("anthropic-messages", "https://api.commandcode.ai/provider");
		const existing = commandCodeModel("anthropic-messages", "https://api.commandcode.ai/provider");
		const merged = mergeDiscoveredModel(discovered, existing, {
			baseUrl: "https://proxy.example/provider/v1",
		});

		expect(merged.baseUrl).toBe("https://proxy.example/provider");
	});

	test("adds /v1 to a bare provider override for OpenAI-completions models", () => {
		const discovered = commandCodeModel("openai-completions", "https://api.commandcode.ai/provider/v1");
		const merged = mergeDiscoveredModel(discovered, undefined, {
			baseUrl: "https://proxy.example/provider",
		});

		expect(merged.baseUrl).toBe("https://proxy.example/provider/v1");
	});
});
