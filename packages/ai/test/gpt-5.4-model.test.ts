import { describe, expect, it } from "bun:test";
import { getBundledModel, supportsXhigh } from "@oh-my-pi/pi-ai";

describe("bundled OpenAI GPT-5.4 model", () => {
	it("registers the latest OpenAI GPT-5.4 definition", () => {
		const model = getBundledModel("openai", "gpt-5.4");

		expect(model).toBeDefined();
		expect(model).toMatchObject({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: {
				input: 2.5,
				output: 15,
				cacheRead: 0.25,
				cacheWrite: 0,
			},
		});
	});

	it("exposes xhigh thinking for GPT-5.4", () => {
		const model = getBundledModel("openai", "gpt-5.4");

		expect(model).toBeDefined();
		expect(supportsXhigh(model)).toBe(true);
	});
});

describe("bundled OpenAI Codex GPT-5.4 model", () => {
	it("registers the bundled OpenAI Codex GPT-5.4 definition", () => {
		const model = getBundledModel("openai-codex", "gpt-5.4");

		expect(model).toBeDefined();
		expect(model).toMatchObject({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			contextWindow: 272_000,
			maxTokens: 128_000,
			preferWebsockets: true,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		});
	});

	it("exposes xhigh thinking for OpenAI Codex GPT-5.4", () => {
		const model = getBundledModel("openai-codex", "gpt-5.4");

		expect(model).toBeDefined();
		expect(supportsXhigh(model)).toBe(true);
	});
});
