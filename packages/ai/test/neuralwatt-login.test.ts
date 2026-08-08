import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("neuralwatt login", () => {
	it("appears in the login list and validates a normalized key against Neuralwatt", async () => {
		expect(getOAuthProviders().map(provider => provider.id)).toContain("neuralwatt");

		const login = getProviderDefinition("neuralwatt")?.login;
		if (!login) throw new Error("Neuralwatt is missing its interactive login callback");

		let authUrl: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://api.neuralwatt.com/v1/quota");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-neuralwatt-test" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await login({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  sk-neuralwatt-test  ";
			},
			fetch: fetchMock,
		});

		expect(authUrl).toBe("https://portal.neuralwatt.com/dashboard/keys");
		expect(promptMessage).toBe("Paste your Neuralwatt API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(apiKey).toBe("sk-neuralwatt-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects an unauthorized key from the quota validation endpoint", async () => {
		const login = getProviderDefinition("neuralwatt")?.login;
		if (!login) throw new Error("Neuralwatt is missing its interactive login callback");

		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://api.neuralwatt.com/v1/quota");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-neuralwatt-invalid" });
			return new Response("Unauthorized", { status: 401 });
		});

		await expect(
			login({
				onAuth: () => {},
				onPrompt: async () => " sk-neuralwatt-invalid ",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Neuralwatt API key validation failed (401)");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
