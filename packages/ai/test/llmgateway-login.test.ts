import { describe, expect, it, vi } from "bun:test";
import { loginLlmGateway } from "@oh-my-pi/pi-ai/registry/llmgateway";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("llmgateway login", () => {
	it("validates the API key against chat completions", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.llmgateway.io/v1/chat/completions");
			expect(init?.method).toBe("POST");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer llmgtwy_test");
			const body = JSON.parse(String(init?.body));
			expect(body.model).toBe("gpt-4o-mini");
			return new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginLlmGateway({
			onPrompt: async () => "llmgtwy_test",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("llmgtwy_test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces validation errors from chat completions", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response('{"error":{"message":"Invalid API key"}}', {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(
			loginLlmGateway({
				onPrompt: async () => "llmgtwy_bad",
				fetch: fetchMock,
			}),
		).rejects.toThrow("LLM Gateway API key validation failed (401)");
	});
});
