import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";

const ENV_KEYS = ["BRAVE_API_KEY", "JINA_API_KEY", "TINYFISH_API_KEY", "FIRECRAWL_API_KEY"] as const;
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

function newStorage(): { store: SqliteAuthCredentialStore; storage: AuthStorage } {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	void storage.reload();
	return { store, storage };
}

describe("search provider login wiring", () => {
	for (const provider of ["brave", "jina", "tinyfish", "firecrawl"] as const) {
		test(`${provider} appears in the login selector`, () => {
			const entry = getOAuthProviders().find(item => item.id === provider);
			expect(entry).toBeDefined();
			expect(entry?.available).toBe(true);
		});

		test(`${provider} login stores the pasted key as a login credential`, async () => {
			const { store, storage } = newStorage();
			await storage.login(provider, { onAuth: () => {}, onPrompt: async () => `${provider}-test-key` });
			expect(await storage.get(provider)).toEqual({
				type: "api_key",
				key: `${provider}-test-key`,
				source: "login",
			});
			store.close();
		});
	}

	test("stored login key beats env key for search providers", async () => {
		const { storage } = newStorage();
		Bun.env.BRAVE_API_KEY = "BSA_env_key";
		await storage.login("brave", { onAuth: () => {}, onPrompt: async () => "BSA_login_key" });
		expect(await storage.getApiKey("brave")).toBe("BSA_login_key");
	});

	test("env key resolves when no credential is stored", () => {
		Bun.env.JINA_API_KEY = "jina_env_key";
		expect(getEnvApiKey("jina")).toBe("jina_env_key");
	});
});
