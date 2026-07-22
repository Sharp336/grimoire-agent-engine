import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

function anthropicCredential(profile: "claude-code" | "cowork", suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: "same-account",
		email: "same@example.com",
		orgId: "same-org",
		clientProfile: profile,
	};
}

describe("AuthStorage Anthropic client profile activation", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	afterEach(async () => {
		storage?.close();
		storage = undefined;
		store = undefined;
		if (tempDir) await removeWithRetries(tempDir);
		unregisterOAuthProviders("auth-client-profile-test");
		tempDir = "";
	});

	async function open(): Promise<{ dbPath: string; auth: AuthStorage }> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-client-profile-"));
		const dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store);
		await storage.reload();
		return { dbPath, auth: storage };
	}

	test("retains the same Anthropic identity once per client profile", async () => {
		const { auth } = await open();
		auth.upsertCredential("anthropic", anthropicCredential("claude-code", "code"));
		auth.upsertCredential("anthropic", anthropicCredential("cowork", "cowork"));

		expect(auth.listStoredCredentials("anthropic")).toHaveLength(2);
		expect(auth.listStoredCredentials("anthropic", { clientProfile: "claude-code" })).toHaveLength(1);
		expect(auth.listStoredCredentials("anthropic", { clientProfile: "cowork" })).toHaveLength(1);
	});

	test("successful alias login activates its profile and survives reload", async () => {
		const { dbPath, auth } = await open();
		for (const profile of ["claude-code", "cowork"] as const) {
			registerOAuthProvider({
				id: `test-anthropic-${profile}`,
				name: `Test Anthropic ${profile}`,
				sourceId: "auth-client-profile-test",
				storeCredentialsAs: "anthropic",
				async login() {
					return anthropicCredential(profile, profile);
				},
			});
		}
		const ctrl = { onAuth: () => {}, onPrompt: async () => "" };
		await auth.login("test-anthropic-claude-code", ctrl);
		await auth.login("test-anthropic-cowork", ctrl);
		expect(auth.getActiveOAuthClientProfile("anthropic")).toBe("cowork");
		expect(auth.listStoredCredentials("anthropic")).toHaveLength(2);

		auth.close();
		storage = undefined;
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store);
		await storage.reload();
		expect(storage.getActiveOAuthClientProfile("anthropic")).toBe("cowork");
	});

	test("persists last activation and selection never crosses profiles", async () => {
		const { dbPath, auth } = await open();
		await auth.set("anthropic", [
			anthropicCredential("claude-code", "code"),
			anthropicCredential("cowork", "cowork"),
		]);
		await auth.setActiveOAuthClientProfile("anthropic", "cowork");
		expect(auth.getOAuthCredential("anthropic")?.access).toBe("access-cowork");
		expect((await auth.getOAuthAccess("anthropic", "cowork-session"))?.accessToken).toBe("access-cowork");
		expect(await auth.peekApiKey("anthropic")).toBe("access-cowork");

		auth.close();
		storage = undefined;
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store);
		await storage.reload();

		expect(storage.getActiveOAuthClientProfile("anthropic")).toBe("cowork");
		expect((await storage.getOAuthAccess("anthropic", "reloaded-session"))?.accessToken).toBe("access-cowork");
		expect(
			await storage.rotateSessionCredential("anthropic", "reloaded-session", {
				error: new Error("401 unauthorized"),
			}),
		).toBe(false);
	});

	test("does not treat an inactive profile as a rotation sibling", async () => {
		const { auth } = await open();
		await auth.set("anthropic", [
			anthropicCredential("claude-code", "code"),
			anthropicCredential("cowork", "cowork"),
		]);
		await auth.setActiveOAuthClientProfile("anthropic", "cowork");
		const coworkId = auth.listStoredCredentials("anthropic", { clientProfile: "cowork" })[0]!.id;

		const result = await auth.markUsageLimitReached("anthropic", undefined, {
			credentialId: coworkId,
			retryAfterMs: 60_000,
		});

		expect(result.switched).toBe(false);
	});

	test("inactive removal preserves activation while active-profile exhaustion falls back then clears", async () => {
		const { auth } = await open();
		await auth.set("anthropic", [
			anthropicCredential("claude-code", "code"),
			anthropicCredential("cowork", "cowork"),
		]);
		await auth.setActiveOAuthClientProfile("anthropic", "cowork");
		const codeId = auth.listStoredCredentials("anthropic", { clientProfile: "claude-code" })[0]!.id;
		const coworkId = auth.listStoredCredentials("anthropic", { clientProfile: "cowork" })[0]!.id;

		await auth.removeCredential("anthropic", codeId);
		expect(auth.getActiveOAuthClientProfile("anthropic")).toBe("cowork");

		await auth.set("anthropic", [
			anthropicCredential("claude-code", "code-2"),
			anthropicCredential("cowork", "cowork"),
		]);
		await auth.removeCredential("anthropic", coworkId);
		expect(auth.getActiveOAuthClientProfile("anthropic")).toBe("claude-code");
		const remainingId = auth.listStoredCredentials("anthropic", { clientProfile: "claude-code" })[0]!.id;
		await auth.removeCredential("anthropic", remainingId);
		expect(auth.getActiveOAuthClientProfile("anthropic")).toBeUndefined();
	});
});
