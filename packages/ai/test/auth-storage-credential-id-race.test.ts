import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ApiKeyCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * Regression guard for the credentialId capture in
 * {@link AuthStorage.getApiKeyResolution}: the SQLite row id attributed to a
 * resolution is read BEFORE awaiting `configValueResolver`, so a mutation of
 * the stored credential set during that await (e.g. a config reload that drops
 * or reorders rows) cannot re-attribute the resolved key to a different row.
 *
 * The resolved key always comes from the pre-await selection's `.key`; this
 * test pins that the paired `credentialId` comes from the same snapshot rather
 * than re-reading the (now-shifted) positional index after the await.
 */
describe("AuthStorage.getApiKeyResolution captures credentialId before configValueResolver await", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	// The resolver is gated: on entry it announces that selection is done and
	// the code is sitting at the capture site, then blocks until the test
	// releases it after mutating the stored credential set. No sleeps — the
	// deferred promise is the sole synchronization point.
	let resolverGate: PromiseWithResolvers<void>;
	let resolverEntered: PromiseWithResolvers<void>;
	let resolverKey: string | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-cred-id-race-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		resolverGate = Promise.withResolvers<void>();
		resolverEntered = Promise.withResolvers<void>();
		resolverKey = undefined;
		authStorage = new AuthStorage(store, {
			configValueResolver: async (config: string) => {
				resolverKey = config;
				resolverEntered.resolve();
				await resolverGate.promise;
				return config;
			},
		});
	});

	afterEach(async () => {
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir.length > 0) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	/**
	 * Seeds two api_key credentials, starts a resolution that blocks inside
	 * `configValueResolver`, removes the selected (index-0) credential while the
	 * await is pending, then releases the resolver. The resolution must still be
	 * attributed to the pre-await credential, even though index 0 then holds a
	 * different row. Reverting the capture (computing the id after the await)
	 * returns the survivor's id and fails the final assertion.
	 */
	async function resolveWhileSnapshotMutates(
		provider: string,
		credentials: [ApiKeyCredential, ApiKeyCredential],
	): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set(provider, credentials);
		const rows = authStorage.listStoredCredentials(provider);
		expect(rows.length).toBe(2);
		const [rowA, rowB] = rows;
		if (!rowA || !rowB) throw new Error("seed credentials not present");
		const selectedId = rowA.id;
		const survivorId = rowB.id;
		expect(survivorId).not.toBe(selectedId);

		const resolutionPromise = authStorage.getApiKeyResolution(provider);
		// Selection has run and the resolver is now blocked at the capture site.
		await resolverEntered.promise;
		expect(resolverKey).toBe(credentials[0].key);

		// Mutate the stored set while the await is still pending: drop the
		// selected row so positional index 0 now points at the survivor.
		await authStorage.removeCredential(provider, selectedId);
		const shifted = authStorage.listStoredCredentials(provider)[0];
		expect(shifted?.id).toBe(survivorId);

		resolverGate.resolve();
		const resolution = await resolutionPromise;

		// The resolved key comes from the pre-await credential...
		expect(resolution?.apiKey).toBe(credentials[0].key);
		// ...so its attributed credentialId must be the pre-await row, not the
		// post-mutation index-0 survivor.
		expect(resolution?.credentialId).toBe(selectedId);
	}

	test("login api_key branch (source: login)", async () => {
		await resolveWhileSnapshotMutates("cred-id-race-login", [
			{ type: "api_key", key: "key-login-A", source: "login" },
			{ type: "api_key", key: "key-login-B", source: "login" },
		]);
	});

	test("stored api_key branch (source is not login)", async () => {
		await resolveWhileSnapshotMutates("cred-id-race-static", [
			{ type: "api_key", key: "key-static-A" },
			{ type: "api_key", key: "key-static-B" },
		]);
	});
});
