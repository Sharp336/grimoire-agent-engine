/**
 * Contract: `AuthStorage.markRateLimited` parks the hot credential behind a
 * short, unscoped, PERSISTED block (clamped to [5s, 120s]) without disabling
 * it or clearing session stickiness, so ranked selection prefers a sibling
 * while the block lasts and returns to the original credential afterwards.
 * `rotateSessionCredential` routes surfaced-marker errors onto this short
 * path (quota-text bases still win the long usage-limit path), and
 * `hasUsableSibling` answers the transport's advisory probe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	formatSurfacedRateLimitMessage,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "openai";
const SESSION = "session-rl";
const OAUTH_PROVIDER = "oauth-rate-limit-block-test";
const OAUTH_SOURCE = "auth-storage-rate-limit-block-oauth-test";

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

/** Minimal OAuth provider whose bearer is the stored access token. */
function registerRateLimitOAuthProvider(): void {
	registerOAuthProvider({
		id: OAUTH_PROVIDER,
		name: "Rate Limit OAuth Unit",
		sourceId: OAUTH_SOURCE,
		async login() {
			return { access: "login", refresh: "login", expires: farExpiry() };
		},
		async refreshToken(credentials) {
			return { ...credentials, access: "minted-access", refresh: "minted-refresh", expires: farExpiry() };
		},
		getApiKey(credentials) {
			return credentials.access;
		},
	});
}

function surfacedError(base: string, retryAfterMs: number | undefined): Error & { status: number } {
	return Object.assign(new Error(formatSurfacedRateLimitMessage(base, retryAfterMs)), { status: 429 });
}

describe("AuthStorage rate-limit rotation blocks", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-rate-limit-block-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store);
		await storage.set(PROVIDER, [
			{ type: "api_key", key: "key-1", source: "login" },
			{ type: "api_key", key: "key-2", source: "login" },
		]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(OAUTH_SOURCE);
		storage?.close();
		store?.close();
		storage = null;
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	function credentialIds(): number[] {
		if (!store) throw new Error("test setup failed");
		return store.listAuthCredentials(PROVIDER).map(row => row.id);
	}

	it("persists a clamped unscoped block and switches to the sibling", async () => {
		if (!storage) throw new Error("test setup failed");
		const before = Date.now();
		const result = await storage.markRateLimited(PROVIDER, SESSION, { retryAfterMs: 1_000, apiKey: "key-1" });
		expect(result).toEqual({ switched: true });

		const blocks = storage.listCredentialBlocks(credentialIds());
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ providerKey: "openai:api_key", blockScope: "" });
		// retryAfterMs 1s clamps up to the 5s floor.
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 5_000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(Date.now() + 5_000);

		// A fresh AuthStorage over the same agent.db still ranks away from the
		// blocked credential (cross-process persistence contract).
		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedStorage = new AuthStorage(reopenedStore);
		await reopenedStorage.reload();
		try {
			expect(await reopenedStorage.getApiKey(PROVIDER, SESSION)).toBe("key-2");
		} finally {
			reopenedStorage.close();
			reopenedStore.close();
		}
	});

	it("clamps oversized retry hints to the 120s ceiling", async () => {
		if (!storage) throw new Error("test setup failed");
		const before = Date.now();
		await storage.markRateLimited(PROVIDER, SESSION, { retryAfterMs: 10 * 60_000, apiKey: "key-1" });
		const blocks = storage.listCredentialBlocks(credentialIds());
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 120_000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(Date.now() + 120_000);
	});

	it("max-merges overlapping blocks so the later expiry survives", async () => {
		if (!storage) throw new Error("test setup failed");
		const before = Date.now();
		await storage.markRateLimited(PROVIDER, SESSION, { retryAfterMs: 120_000, apiKey: "key-1" });
		await storage.markRateLimited(PROVIDER, SESSION, { retryAfterMs: 1_000, apiKey: "key-1" });
		const blocks = storage.listCredentialBlocks(credentialIds());
		expect(blocks).toHaveLength(1);
		// The later (shorter) mark must not shrink the standing 120s block.
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 120_000);
	});

	it("routes around the block while it lasts and returns to the original credential after expiry", async () => {
		if (!storage) throw new Error("test setup failed");
		const first = await storage.getApiKey(PROVIDER, SESSION);
		expect(first).toBe("key-1");

		await storage.markRateLimited(PROVIDER, SESSION, { retryAfterMs: 1_000, apiKey: first });
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("key-2");

		const realNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(realNow + 10_000);
		// Block expired → the session returns to its original credential
		// (markRateLimited never cleared the session's selection state).
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("key-1");
	});

	it("rotateSessionCredential takes the short-park path for marker errors without disabling the credential", async () => {
		if (!storage || !store) throw new Error("test setup failed");
		const before = Date.now();
		const switched = await storage.rotateSessionCredential(PROVIDER, SESSION, {
			error: surfacedError("429 Too many requests", 30_000),
			apiKey: "key-1",
		});
		expect(switched).toBe(true);

		// Healthy credential: never disabled, never suspect-marked — both rows stay usable.
		const rows = store.listAuthCredentials(PROVIDER);
		expect(rows).toHaveLength(2);
		// Short block honoring the embedded hint (30s ≤ 120s ceiling).
		const blocks = storage.listCredentialBlocks(rows.map(row => row.id));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 30_000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(Date.now() + 120_000);
	});

	it("rotateSessionCredential reports no switch when every sibling is blocked", async () => {
		if (!storage) throw new Error("test setup failed");
		await storage.markRateLimited(PROVIDER, SESSION, { retryAfterMs: 60_000, apiKey: "key-2" });
		const switched = await storage.rotateSessionCredential(PROVIDER, SESSION, {
			error: surfacedError("429 Too many requests", 30_000),
			apiKey: "key-1",
		});
		expect(switched).toBe(false);
	});

	it("does not ping-pong when a sibling raced away: declines without routing back to the blocked original", async () => {
		if (!storage) throw new Error("test setup failed");
		// Session A stickies onto whichever row ranking picks (session-dependent).
		const firstKey = await storage.getApiKey(PROVIDER, "sess-a");
		const siblingKey = firstKey === "key-1" ? "key-2" : "key-1";

		// Surfaced 429 on session A's key: park it; the free sibling → switch.
		expect(
			await storage.rotateSessionCredential(PROVIDER, "sess-a", {
				error: surfacedError("429 Too many requests", 30_000),
				apiKey: firstKey,
			}),
		).toBe(true);

		// The unscoped park is global, so session B resolves to the surviving
		// sibling and sticks there; from B the only sibling (session A's parked
		// key) is blocked, so no usable sibling remains.
		expect(await storage.getApiKey(PROVIDER, "sess-b")).toBe(siblingKey);
		expect(storage.hasUsableSibling(PROVIDER, "sess-b")).toBe(false);
		expect(storage.listCredentialBlocks(credentialIds())).toHaveLength(1);

		// Surfaced 429 on the sibling while the original is still blocked: no
		// sibling to move to.
		expect(
			await storage.rotateSessionCredential(PROVIDER, "sess-b", {
				error: surfacedError("429 Too many requests", 30_000),
				apiKey: siblingKey,
			}),
		).toBe(false);

		// No ping-pong: the failing sibling is parked in place (standard max-merge
		// rate-limit record — both rows now blocked) and rotation declines rather
		// than routing session B back onto the still-blocked original.
		const blocks = storage.listCredentialBlocks(credentialIds());
		expect(blocks).toHaveLength(2);
		expect(storage.hasUsableSibling(PROVIDER, "sess-b")).toBe(false);
	});

	it("quota-text bases outrank the marker: the long usage-limit block wins", async () => {
		if (!storage) throw new Error("test setup failed");
		const before = Date.now();
		const switched = await storage.rotateSessionCredential(PROVIDER, SESSION, {
			// Base matches the usage-limit patterns; retry hint of 1s would give a
			// 5s block on the rate-limit path — the usage path's 60s default proves
			// which branch ran.
			error: surfacedError("429 insufficient_quota: You exceeded your current quota", 1_000),
			apiKey: "key-1",
		});
		expect(switched).toBe(true);
		const blocks = storage.listCredentialBlocks(credentialIds());
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 60_000);
	});

	it("hasUsableSibling tracks sticky, blocks, and block expiry", async () => {
		if (!storage) throw new Error("test setup failed");
		// Sticky on key-1, unblocked sibling → true.
		await storage.getApiKey(PROVIDER, SESSION);
		expect(storage.hasUsableSibling(PROVIDER, SESSION)).toBe(true);

		// All siblings blocked → false.
		await storage.markRateLimited(PROVIDER, SESSION, { retryAfterMs: 30_000, apiKey: "key-2" });
		expect(storage.hasUsableSibling(PROVIDER, SESSION)).toBe(false);

		// Sibling block expired → true again.
		const realNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000);
		expect(storage.hasUsableSibling(PROVIDER, SESSION)).toBe(true);
	});

	it("hasUsableSibling declines when there is no sticky session (in-use credential unknowable)", async () => {
		if (!storage) throw new Error("test setup failed");
		// No sticky yet: the caller's in-use credential is unidentifiable and
		// rotation is same-type-only, so the probe declines rather than guessing.
		// (#recordSessionCredential runs at resolve time before any request, so a
		// real rotation-enabled 429 always has a sticky — no-sticky is an anomaly.)
		expect(storage.hasUsableSibling(PROVIDER)).toBe(false);
	});

	it("hasUsableSibling declines with no sticky even when both rows are fully unblocked", async () => {
		if (!storage) throw new Error("test setup failed");
		// Two unblocked rows and no block anywhere still declines: without a sticky
		// we cannot tell which row is in use, and a cross-type row could not rotate.
		const blocks = storage.listCredentialBlocks(credentialIds());
		expect(blocks).toHaveLength(0);
		expect(storage.hasUsableSibling(PROVIDER)).toBe(false);
	});

	it("hasUsableSibling is false for a single-credential pool", async () => {
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [{ type: "api_key", key: "only-key", source: "login" }]);
		await storage.getApiKey(PROVIDER, SESSION);
		expect(storage.hasUsableSibling(PROVIDER, SESSION)).toBe(false);
	});

	it("attributes a delayed 429 through the OAuth bearer alias and blocks the correct row", async () => {
		if (!storage || !store) throw new Error("test setup failed");
		registerRateLimitOAuthProvider();
		await storage.set(OAUTH_PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		// Resolve a bearer for the session: records the bearer→row fingerprint.
		const sessionId = "oauth-bearer-alias";
		const previousKey = await storage.getApiKey(OAUTH_PROVIDER, sessionId);
		if (!previousKey) throw new Error("expected initial OAuth bearer");
		const rows = store.listAuthCredentials(OAUTH_PROVIDER);
		const target = rows.find(row => row.credential.type === "oauth" && row.credential.access === previousKey);
		const sibling = rows.find(row => row.id !== target?.id);
		if (target?.credential.type !== "oauth" || sibling?.credential.type !== "oauth") {
			throw new Error("expected target and sibling OAuth rows");
		}

		// A concurrent refresh rotated the row's live access token, so the stale
		// bearer no longer matches any credential directly — markRateLimited must
		// fall back to the recorded bearer alias to attribute the 429.
		store.updateAuthCredential(target.id, { ...target.credential, access: `${previousKey}-refreshed` });
		await storage.reload();

		const before = Date.now();
		const result = await storage.markRateLimited(OAUTH_PROVIDER, sessionId, {
			apiKey: previousKey,
			retryAfterMs: 30_000,
		});
		expect(result).toEqual({ switched: true });

		// Exactly the aliased row is parked (short clamped block), not the sibling.
		const blocks = storage.listCredentialBlocks(rows.map(row => row.id));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			credentialId: target.id,
			providerKey: `${OAUTH_PROVIDER}:oauth`,
			blockScope: "",
		});
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 30_000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(Date.now() + 120_000);

		// The session now ranks onto the still-usable sibling account.
		expect(await storage.getApiKey(OAUTH_PROVIDER, sessionId)).toBe(sibling.credential.access);
	});

	it("resolver() rotates onto the sibling for a surfaced marker error when one is usable", async () => {
		if (!storage) throw new Error("test setup failed");
		const resolver = storage.resolver(PROVIDER, { sessionId: SESSION });
		// Initial resolve stickies the session; ranking order is session-dependent,
		// so derive the sibling from whichever key was picked.
		const firstKey = await resolver({ lastChance: false, error: undefined });
		if (firstKey !== "key-1" && firstKey !== "key-2") throw new Error("expected a stored key");
		const siblingKey = firstKey === "key-1" ? "key-2" : "key-1";

		// Surfaced marker on the sticky key at last chance: rotateSessionCredential
		// parks it behind a persisted block and the resolver re-resolves onto the
		// sibling instead of stopping (the single-credential undefined path).
		expect(
			await resolver({
				lastChance: true,
				error: surfacedError("429 Too many requests", 12_000),
				previousKey: firstKey,
			}),
		).toBe(siblingKey);
		expect(storage.listCredentialBlocks(credentialIds())).toHaveLength(1);
	});

	it("resolver() stops on a surfaced marker error when rotation finds no sibling", async () => {
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [{ type: "api_key", key: "only-key", source: "login" }]);
		const resolver = storage.resolver(PROVIDER, { sessionId: SESSION });
		expect(await resolver({ lastChance: false, error: undefined })).toBe("only-key");
		// No sibling to rotate to → `undefined` hands control to the stream
		// driver's stall fallback instead of re-resolving the blocked credential.
		expect(
			await resolver({
				lastChance: true,
				error: surfacedError("429 Too many requests", 12_000),
				previousKey: "only-key",
			}),
		).toBeUndefined();
	});
});
