import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const originalDeepInfraApiKey = Bun.env.DEEPINFRA_API_KEY;

afterEach(() => {
	if (originalDeepInfraApiKey === undefined) {
		delete Bun.env.DEEPINFRA_API_KEY;
	} else {
		Bun.env.DEEPINFRA_API_KEY = originalDeepInfraApiKey;
	}
	vi.restoreAllMocks();
});

describe("DeepInfra login wiring", () => {
	test("registers DeepInfra in the API-key provider selector", () => {
		expect(getOAuthProviders().find(provider => provider.id === "deepinfra")).toMatchObject({
			id: "deepinfra",
			name: "DeepInfra",
			available: true,
		});
	});

	test("resolves DEEPINFRA_API_KEY from environment", () => {
		Bun.env.DEEPINFRA_API_KEY = "deepinfra-env-key";
		expect(getEnvApiKey("deepinfra")).toBe("deepinfra-env-key");
	});

	test("validates and stores a pasted DeepInfra API key", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
			expect(init?.method).toBe("POST");
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer deepinfra-test-key");
			expect(JSON.parse(String(init?.body))).toEqual({
				model: "deepseek-ai/DeepSeek-V3",
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				temperature: 0,
			});
			return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("deepinfra", {
			onAuth: () => {},
			onPrompt: async () => "deepinfra-test-key",
			fetch: fetchMock,
		});

		expect(await storage.get("deepinfra")).toEqual({
			type: "api_key",
			key: "deepinfra-test-key",
			source: "login",
		});
		store.close();
	});

	test("rejects invalid DeepInfra API keys without storing them", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await expect(
			storage.login("deepinfra", {
				onAuth: () => {},
				onPrompt: async () => "deepinfra-invalid-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow(/DeepInfra API key validation failed \(401\)/);
		expect(await storage.get("deepinfra")).toBeUndefined();
		store.close();
	});
});
