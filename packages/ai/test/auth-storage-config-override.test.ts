import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage config-override apiKey", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-config-override-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedOAuth(provider: string, access: string): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(provider, [
			{
				type: "oauth",
				access,
				refresh: `${access}-refresh`,
				expires: Date.now() + 60 * 60_000,
			},
		]);
	}

	test("setConfigApiKeys beats OAuth access token for getApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKeys("anthropic", ["gateway-bearer"]);

			expect(await authStorage.getApiKey("anthropic")).toBe("gateway-bearer");
			expect(await authStorage.peekApiKey("anthropic")).toBe("gateway-bearer");
		});
	});

	test("runtime override (--api-key) still beats setConfigApiKeys", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKeys("anthropic", ["gateway-bearer"]);
			authStorage.setRuntimeApiKey("anthropic", "cli-flag-bearer");

			expect(await authStorage.getApiKey("anthropic")).toBe("cli-flag-bearer");
		});
	});

	test("removeConfigApiKey restores OAuth resolution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKeys("anthropic", ["gateway-bearer"]);
			expect(await authStorage.getApiKey("anthropic")).toBe("gateway-bearer");

			authStorage.removeConfigApiKey("anthropic");
			expect(await authStorage.getApiKey("anthropic")).toBe("oauth-from-broker");
		});
	});

	test("rotates to an unblocked configured key after a usage limit", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			authStorage.setConfigApiKeys("anthropic", ["config-first", "config-second"]);

			const first = await authStorage.getApiKey("anthropic", "rotation-session");
			expect(first).toBeDefined();
			expect(await authStorage.markUsageLimitReached("anthropic", "rotation-session")).toEqual({
				switched: true,
			});
			expect(await authStorage.getApiKey("anthropic", "rotation-session")).not.toBe(first);
		});
	});

	test("does not transfer a blocked position to a replacement config key", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			authStorage.setConfigApiKeys("anthropic", ["old-first", "old-second"]);
			expect(await authStorage.getApiKey("anthropic")).toBe("old-first");
			await authStorage.markUsageLimitReached("anthropic", undefined, { apiKey: "old-first" });

			authStorage.setConfigApiKeys("anthropic", ["replacement-first", "replacement-second"]);
			expect(await authStorage.getApiKey("anthropic")).toBe("replacement-second");
			expect(await authStorage.getApiKey("anthropic")).toBe("replacement-first");
		});
	});

	test("rotates comma-separated environment keys after a usage limit", async () => {
		await withEnv({ ...SUPPRESS_ANTHROPIC_ENV, ANTHROPIC_API_KEY: "env-first, env-second" }, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const first = await authStorage.getApiKey("anthropic", "env-rotation-session");
			expect(first).toBeDefined();
			expect(await authStorage.markUsageLimitReached("anthropic", "env-rotation-session")).toEqual({
				switched: true,
			});
			expect(await authStorage.getApiKey("anthropic", "env-rotation-session")).not.toBe(first);
		});
	});

	test("clearConfigApiKeys drops every config override at once", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-anthropic");
			await seedOAuth("openai-codex", "oauth-codex");
			authStorage.setConfigApiKeys("anthropic", ["gateway-bearer-A"]);
			authStorage.setConfigApiKeys("openai-codex", ["gateway-bearer-B"]);

			authStorage.clearConfigApiKeys();

			expect(await authStorage.getApiKey("anthropic")).toBe("oauth-anthropic");
			expect(await authStorage.getApiKey("openai-codex")).toBe("oauth-codex");
		});
	});

	test("setConfigApiKeys suppresses OAuth account_uuid attribution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "oauth-with-account",
					refresh: "r",
					expires: Date.now() + 60 * 60_000,
					accountId: "acc-123",
				},
			]);
			// Sanity: without override, accountId is exposed.
			expect(authStorage.getOAuthAccountId("anthropic")).toBe("acc-123");

			authStorage.setConfigApiKeys("anthropic", ["gateway-bearer-a", "gateway-bearer-b"]);
			// With explicit config bearers in play, OAuth access and account
			// attribution must NOT leak — outbound auth is the gateway bearer, not OAuth.
			expect(await authStorage.getOAuthAccess("anthropic")).toBeUndefined();
			expect(authStorage.getOAuthAccountId("anthropic")).toBeUndefined();
		});
	});

	test("describeCredentialSource reports config override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKeys("anthropic", ["gateway-bearer"]);
			expect(authStorage.describeCredentialSource("anthropic")).toBe("config override (models.yml)");
		});
	});
});
