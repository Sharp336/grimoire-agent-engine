import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	isOAuthCredentialResolver,
	SqliteAuthCredentialStore,
	seedOAuthCredentialResolver,
} from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "xai-grok-build";

describe("AuthStorage OAuth-only providers", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-only-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("ignores every key source and exposes only stored OAuth identity", async () => {
		if (!authStorage) throw new Error("test setup failed");
		authStorage.setRuntimeApiKey(PROVIDER, "runtime");
		authStorage.setConfigApiKey(PROVIDER, "config");
		authStorage.setFallbackResolver(provider => (provider === PROVIDER ? "fallback" : undefined));
		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: "login", source: "login" },
			{ type: "api_key", key: "stored" },
		]);

		expect(authStorage.hasAuth(PROVIDER)).toBe(false);
		expect(authStorage.hasNonEnvCredential(PROVIDER)).toBe(false);
		expect(authStorage.getCredentialOrigin(PROVIDER)).toBeUndefined();
		expect(await authStorage.peekApiKey(PROVIDER)).toBeUndefined();
		expect(await authStorage.getApiKey(PROVIDER)).toBeUndefined();
		expect(authStorage.describeCredentialSource(PROVIDER)).toBeUndefined();

		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: "forbidden" },
			{
				type: "oauth",
				access: "oauth-access",
				refresh: "oauth-refresh",
				expires: Date.now() + 60 * 60_000,
				accountId: "account-1",
				email: "build@example.test",
			},
		]);

		expect(authStorage.hasAuth(PROVIDER)).toBe(true);
		expect(authStorage.getCredentialOrigin(PROVIDER)).toEqual({ kind: "oauth" });
		expect(await authStorage.getApiKey(PROVIDER)).toBe("oauth-access");
		expect(await authStorage.getOAuthAccess(PROVIDER)).toMatchObject({
			accessToken: "oauth-access",
			accountId: "account-1",
			email: "build@example.test",
		});
		expect(authStorage.describeCredentialSource(PROVIDER)).toContain("build@example.test");
	});

	test("account APIs retain Build OAuth despite mixed API-key overrides", async () => {
		if (!authStorage) throw new Error("test setup failed");
		authStorage.setRuntimeApiKey(PROVIDER, "runtime");
		authStorage.setConfigApiKey(PROVIDER, "config");
		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: "stored" },
			{
				type: "oauth",
				access: "oauth-access",
				refresh: "oauth-refresh",
				expires: Date.now() + 60 * 60_000,
				accountId: "account-1",
				email: "build@example.test",
			},
		]);

		expect(authStorage.listOAuthAccounts(PROVIDER)).toEqual([
			expect.objectContaining({ position: 0, accountId: "account-1", email: "build@example.test" }),
		]);
		expect(await authStorage.getOAuthAccesses(PROVIDER)).toEqual([
			expect.objectContaining({ ok: true, accessToken: "oauth-access", accountId: "account-1" }),
		]);
		expect(await authStorage.getOAuthAccessAt(PROVIDER, 0)).toEqual(
			expect.objectContaining({ ok: true, accessToken: "oauth-access", accountId: "account-1" }),
		);
	});

	test("account APIs still let API-key overrides replace OAuth for non-OAuth-only providers", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "xai-oauth";
		authStorage.setRuntimeApiKey(provider, "runtime");
		authStorage.setConfigApiKey(provider, "config");
		await authStorage.set(provider, [
			{ type: "api_key", key: "stored" },
			{
				type: "oauth",
				access: "oauth-access",
				refresh: "oauth-refresh",
				expires: Date.now() + 60 * 60_000,
			},
		]);

		expect(authStorage.listOAuthAccounts(provider)).toEqual([]);
		expect(await authStorage.getOAuthAccesses(provider)).toEqual([]);
		expect(await authStorage.getOAuthAccessAt(provider, 0)).toBeUndefined();
	});

	test("mints provider-bound provenance that generic seeding cannot forge", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60 * 60_000 },
		]);
		const resolver = authStorage.createOAuthApiKeyResolver(PROVIDER, "session");
		expect(isOAuthCredentialResolver(resolver, PROVIDER)).toBe(true);
		expect(isOAuthCredentialResolver(resolver, "xai-oauth")).toBe(false);

		const seeded = await seedOAuthCredentialResolver(resolver, PROVIDER);
		expect(isOAuthCredentialResolver(seeded, PROVIDER)).toBe(true);
		expect(await seeded({ lastChance: false, error: undefined })).toBe("oauth-access");
		expect(() => authStorage?.createOAuthApiKeyResolver("xai-oauth")).toThrow("Provider is not OAuth-only");
	});

	test("disables a permanently failed expired OAuth credential without key fallback", async () => {
		if (!store) throw new Error("test setup failed");
		authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async () => {
				throw new Error("invalid_grant: refresh token revoked");
			},
		});
		authStorage.setRuntimeApiKey(PROVIDER, "runtime");
		authStorage.setConfigApiKey(PROVIDER, "config");
		authStorage.setFallbackResolver(() => "fallback");
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "expired", refresh: "revoked", expires: Date.now() - 1_000 },
			{ type: "api_key", key: "stored" },
		]);

		expect(await authStorage.getApiKey(PROVIDER)).toBeUndefined();
		expect(authStorage.hasAuth(PROVIDER)).toBe(false);
		expect(authStorage.listStoredCredentials(PROVIDER).every(row => row.credential.type !== "oauth")).toBe(true);
	});

	test("trusted resolver force-refreshes the sticky account then rotates to its sibling", async () => {
		if (!store) throw new Error("test setup failed");
		let refreshes = 0;
		authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, _credentialId, credential) => {
				refreshes += 1;
				return { ...credential, access: `${credential.access}-refreshed`, expires: Date.now() + 60 * 60_000 };
			},
		});
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "account-a", refresh: "refresh-a", expires: Date.now() + 60 * 60_000 },
			{ type: "oauth", access: "account-b", refresh: "refresh-b", expires: Date.now() + 60 * 60_000 },
		]);
		const resolver = authStorage.createOAuthApiKeyResolver(PROVIDER, "sticky");
		const initial = await resolver({ lastChance: false, error: undefined });
		const refreshed = await resolver({ lastChance: false, error: new Error("401") });
		const rotated = await resolver({ lastChance: true, error: Object.assign(new Error("401"), { status: 401 }) });

		expect(refreshes).toBe(1);
		expect(refreshed).toBe(`${initial}-refreshed`);
		expect(rotated).toBe(initial === "account-a" ? "account-b" : "account-a");
	});
});
