import { describe, expect, test, vi } from "bun:test";
import { loginAtlasCloud } from "@oh-my-pi/pi-ai/registry/atlascloud";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("Atlas Cloud login", () => {
	test("registers Atlas Cloud as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "atlascloud");
		expect(provider).toMatchObject({ id: "atlascloud", name: "Atlas Cloud", available: true });
	});

	test("validates pasted key against the OpenAI-compatible models endpoint", async () => {
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const prompts: Array<{ message: string; placeholder?: string }> = [];
		const requests: Array<{
			url: string;
			method: string | undefined;
			authorization: string | null;
		}> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				method: init?.method,
				authorization: headers.get("authorization"),
			});
			return Response.json({ object: "list", data: [{ id: "qwen/qwen3.5-flash" }] });
		});

		const apiKey = await loginAtlasCloud({
			onAuth: info => authEvents.push(info),
			onPrompt: async prompt => {
				prompts.push(prompt);
				return "  atlascloud-test-key  ";
			},
			fetch: fetchMock,
		});

		expect(apiKey).toBe("atlascloud-test-key");
		expect(authEvents).toEqual([
			{
				url: "https://www.atlascloud.ai/console/api-keys",
				instructions: "Create or copy your API key from the Atlas Cloud console",
			},
		]);
		expect(prompts).toEqual([{ message: "Paste your Atlas Cloud API key", placeholder: "apikey-..." }]);
		expect(requests).toEqual([
			{
				url: "https://api.atlascloud.ai/v1/models",
				method: "GET",
				authorization: "Bearer atlascloud-test-key",
			},
		]);
	});

	test("surfaces models endpoint validation errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => new Response('{"error":"invalid_api_key"}', { status: 401 }));

		await expect(
			loginAtlasCloud({
				onPrompt: async () => "atlascloud-test-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Atlas Cloud API key validation failed (401)");
	});
});
