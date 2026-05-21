import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginNearAI } from "../src/utils/oauth/nearai";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("nearai login", () => {
	it("opens NEAR AI Cloud and validates against chat completions", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://cloud-api.near.ai/v1/chat/completions");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"Content-Type": "application/json",
				Authorization: "Bearer nearai-test-key",
			});
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: "zai-org/GLM-5.1-FP8",
				max_tokens: 1,
			});
			return new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginNearAI({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "nearai-test-key";
			},
		});

		expect(authUrl).toBe("https://cloud.near.ai");
		expect(authInstructions).toContain("NEAR AI Cloud API key");
		expect(promptMessage).toBe("Paste your NEAR AI Cloud API key");
		expect(promptPlaceholder).toBe("NEARAI_API_KEY");
		expect(apiKey).toBe("nearai-test-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects empty keys", async () => {
		await expect(
			loginNearAI({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginNearAI({})).rejects.toThrow("NEAR AI Cloud login requires onPrompt callback");
	});

	it("surfaces chat completion validation errors", async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginNearAI({
				onPrompt: async () => "nearai-test-key",
			}),
		).rejects.toThrow("NEAR AI Cloud API key validation failed (401)");
	});
});
