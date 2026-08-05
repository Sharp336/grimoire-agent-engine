import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const ENV_KEYS = [
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"AIMLAPI_API_KEY",
	"AZURE_OPENAI_API_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const original = originalEnv.get(key);
		if (original === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = original;
		}
	}
	vi.restoreAllMocks();
});

/** Endpoints the mocked validators expect; mirrors each provider's login def. */
const VALIDATION_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1/models",
	google: "https://generativelanguage.googleapis.com/v1beta/openai/models",
	groq: "https://api.groq.com/openai/v1/models",
	mistral: "https://api.mistral.ai/v1/models",
	minimax: "https://api.minimax.io/anthropic/v1/messages",
	aimlapi: "https://api.aimlapi.com/v1/models",
};

function mockValidatingFetch(provider: string): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
		if (url === VALIDATION_URLS[provider]) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
}

function newStorage(): { store: SqliteAuthCredentialStore; storage: AuthStorage } {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	void storage.reload();
	return { store, storage };
}

describe("env-key model provider login wiring", () => {
	for (const provider of ["openai", "google", "groq", "mistral", "minimax", "aimlapi"] as const) {
		test(`${provider} appears in the login selector`, () => {
			const entry = getOAuthProviders().find(item => item.id === provider);
			expect(entry).toBeDefined();
			expect(entry?.available).toBe(true);
		});

		test(`${provider} login validates and stores the pasted key`, async () => {
			const { store, storage } = newStorage();
			await storage.login(provider, {
				onAuth: () => {},
				onPrompt: async () => "sk-test-key",
				fetch: mockValidatingFetch(provider),
			});
			expect(await storage.get(provider)).toEqual({ type: "api_key", key: "sk-test-key", source: "login" });
			store.close();
		});
	}

	test("azure login stores the key without validation (endpoint is user-configured)", async () => {
		const { store, storage } = newStorage();
		await storage.login("azure", { onAuth: () => {}, onPrompt: async () => "azure-test-key" });
		expect(await storage.get("azure")).toEqual({ type: "api_key", key: "azure-test-key", source: "login" });
		store.close();
	});

	test("env keys still resolve for providers with no stored credential", () => {
		Bun.env.OPENAI_API_KEY = "sk-env-key";
		Bun.env.GEMINI_API_KEY = "AIza-env-key";
		expect(getEnvApiKey("openai")).toBe("sk-env-key");
		expect(getEnvApiKey("google")).toBe("AIza-env-key");
	});
});
