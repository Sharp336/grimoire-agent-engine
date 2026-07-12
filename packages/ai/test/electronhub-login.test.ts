import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { loginElectronHub } from "@oh-my-pi/pi-ai/registry/electronhub";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const originalElectronHubDevKey = Bun.env.ELECTRONHUB_DEV_API_KEY;
const originalElectronHubKey = Bun.env.ELECTRONHUB_API_KEY;

afterEach(() => {
	if (originalElectronHubDevKey === undefined) {
		delete Bun.env.ELECTRONHUB_DEV_API_KEY;
	} else {
		Bun.env.ELECTRONHUB_DEV_API_KEY = originalElectronHubDevKey;
	}
	if (originalElectronHubKey === undefined) {
		delete Bun.env.ELECTRONHUB_API_KEY;
	} else {
		Bun.env.ELECTRONHUB_API_KEY = originalElectronHubKey;
	}
	vi.restoreAllMocks();
});

describe("electronhub login wiring", () => {
	test("registers ElectronHub in the /login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "electronhub");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("ElectronHub Coding Plan (DevPass)");
		expect(provider?.available).toBe(true);
	});

	test("resolves ELECTRONHUB_DEV_API_KEY first, then ELECTRONHUB_API_KEY", () => {
		Bun.env.ELECTRONHUB_DEV_API_KEY = "ek-dev-env";
		Bun.env.ELECTRONHUB_API_KEY = "ek-fallback";
		expect(getEnvApiKey("electronhub")).toBe("ek-dev-env");

		delete Bun.env.ELECTRONHUB_DEV_API_KEY;
		expect(getEnvApiKey("electronhub")).toBe("ek-fallback");
	});

	test("loginElectronHub trims key and validates against /v1/chat/completions with kimi-k2.6:dev", async () => {
		const originalFetch = globalThis.fetch;
		const globalFetchSpy = vi.fn(async () => {
			throw new Error("unexpected global fetch (live network)");
		});
		globalThis.fetch = globalFetchSpy as unknown as typeof globalThis.fetch;
		try {
			let validationBody: Record<string, unknown> | undefined;
			let validationUrl = "";
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				validationUrl =
					typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
				expect(validationUrl).toBe("https://api.electronhub.ai/v1/chat/completions");
				expect(init?.method).toBe("POST");
				const headers = new Headers(init?.headers);
				expect(headers.get("Content-Type")).toBe("application/json");
				expect(headers.get("Authorization")).toBe("Bearer ek-dev-test");

				validationBody =
					typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
				return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const apiKey = await loginElectronHub({
				onPrompt: async () => "  ek-dev-test  ",
				fetch: fetchMock,
			});

			expect(apiKey).toBe("ek-dev-test");
			expect(validationBody).toMatchObject({
				model: "kimi-k2.6:dev",
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				temperature: 0,
			});
			expect(validationUrl).toBe("https://api.electronhub.ai/v1/chat/completions");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(globalFetchSpy).toHaveBeenCalledTimes(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("AuthStorage.login('electronhub') validates and stores the trimmed key", async () => {
		const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			fetchCalls.push({ url, init });
			if (url === "https://api.electronhub.ai/v1/chat/completions") {
				return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("electronhub", {
			onAuth: () => {},
			onPrompt: async () => "  ek-dev-trimmed  ",
			fetch: fetchMock,
		});

		expect(await storage.get("electronhub")).toEqual({ type: "api_key", key: "ek-dev-trimmed", source: "login" });

		expect(fetchCalls.map(call => call.url)).toEqual(["https://api.electronhub.ai/v1/chat/completions"]);
		const headers = new Headers(fetchCalls[0]?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer ek-dev-trimmed");

		const body =
			typeof fetchCalls[0]?.init?.body === "string"
				? (JSON.parse(fetchCalls[0]!.init!.body as string) as Record<string, unknown>)
				: undefined;
		expect(body).toMatchObject({ model: "kimi-k2.6:dev" });

		store.close();
	});
});
