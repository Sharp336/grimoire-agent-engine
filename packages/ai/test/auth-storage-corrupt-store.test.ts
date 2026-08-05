/**
 * Regression coverage for the corrupt-credential-store latch.
 *
 * `~/.omp/agent/agent.db` can fail `PRAGMA integrity_check` (e.g. "Rowid out of
 * order"). Before the latch, `AuthStorage.#readPersistedCredentialBlock` swallowed
 * every store error at `debug` and returned `undefined`, which its caller read as
 * "this credential is not blocked." A damaged store therefore silently switched
 * off every persisted rate-limit block — one session logged that swallow 546 times
 * for a single credential while a continuous stream of 429s poured in.
 *
 * The fix latches the store as damaged on the first unrecoverable (SQLITE_CORRUPT
 * family / SQLITE_NOTADB) error, reports it once at `error` level with a repair
 * one-liner, and short-circuits every later persisted-block query for the life of
 * the process. Fail-open is preserved: the in-memory backoff map still carries
 * within-process rate-limit state, so only cross-process persistence is lost.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { logger } from "@oh-my-pi/pi-utils";
import { isSqliteCorruptError, sqliteRepairGuidance } from "@oh-my-pi/pi-utils/sqlite";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";

interface SqliteCorruptShape extends Error {
	code: string;
	errno: number;
}

function makeCorruptError(code: string, errno: number): SqliteCorruptShape {
	const err = new Error("database disk image is malformed") as SqliteCorruptShape;
	err.code = code;
	err.errno = errno;
	return err;
}

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

/**
 * Writes a deterministic malformed SQLite source — bytes that are not a valid
 * SQLite database — and returns the path. Opening this with `new Database(path)`
 * and running a query makes bun:sqlite throw a real `SQLiteError` carrying
 * `code: "SQLITE_NOTADB"` (errno 26), the same family the latch classifies.
 */
async function writeMalformedDb(dir: string): Promise<string> {
	const dbPath = path.join(dir, "malformed.db");
	await fs.writeFile(dbPath, "this is not a sqlite database");
	return dbPath;
}

/** The real error bun:sqlite throws when a query hits a malformed database file. */
function realCorruptError(malformedDbPath: string): Error {
	const db = new Database(malformedDbPath);
	try {
		db.run("PRAGMA integrity_check");
	} catch (err) {
		return err as Error;
	} finally {
		db.close();
	}
	// Unreachable: the query above always throws on a malformed file.
	throw new Error("expected SQLITE_NOTADB from malformed database");
}

describe("isSqliteCorruptError", () => {
	test("recognizes the CORRUPT family and NOTADB", () => {
		expect(isSqliteCorruptError(makeCorruptError("SQLITE_CORRUPT", 11))).toBe(true);
		expect(isSqliteCorruptError(makeCorruptError("SQLITE_CORRUPT_VTAB", 267))).toBe(true);
		expect(isSqliteCorruptError(makeCorruptError("SQLITE_NOTADB", 26))).toBe(true);
	});

	test("rejects non-corrupt codes and non-error values", () => {
		expect(isSqliteCorruptError(makeCorruptError("SQLITE_BUSY", 5))).toBe(false);
		expect(isSqliteCorruptError(new Error("plain"))).toBe(false);
		expect(isSqliteCorruptError(null)).toBe(false);
		// A bare string is not an object, so it must not match even if it looks like a code.
		expect(isSqliteCorruptError("SQLITE_CORRUPT")).toBe(false);
	});

	test("classifies the real error bun:sqlite throws on a malformed database file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-real-"));
		try {
			const malformedDbPath = await writeMalformedDb(tempDir);
			const err = realCorruptError(malformedDbPath);
			// Bun 1.3.14 throws SQLiteError with code SQLITE_NOTADB.
			expect((err as { code?: unknown }).code).toBe("SQLITE_NOTADB");
			expect(isSqliteCorruptError(err)).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("AuthStorage corrupt-store latch", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-latch-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("latches after one corrupt read and stops re-querying the store", async () => {
		const malformedDbPath = await writeMalformedDb(tempDir);
		// The spy opens the malformed file and runs a real query so SQLite
		// itself throws SQLITE_NOTADB — the same error shape production sees
		// when agent.db is damaged — rather than a synthetic error object.
		const spy = vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});

		// Drive the credential-selection path twice. The first call hits the
		// store, throws SQLITE_NOTADB, and latches #storeDamaged; the second
		// call (and every later read in the same getApiKey) short-circuits
		// before touching SQLite. Before the fix this re-queried on every
		// credential evaluation — 546 times for one credential in production.
		const key1 = await storage.getApiKey(PROVIDER, "session-latch-1");
		const key2 = await storage.getApiKey(PROVIDER, "session-latch-1");

		// The spy fired exactly once across both calls: the latch stops the repeat.
		expect(spy).toHaveBeenCalledTimes(1);
		// Fail-open is preserved: selection still returns a usable key.
		expect(key1).toBe("access-1");
		expect(key2).toBe("access-1");
	});

	test("latches the write path: one corrupt upsert stops all later block-table writes", async () => {
		const malformedDbPath = await writeMalformedDb(tempDir);
		const spy = vi.spyOn(store, "upsertCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const generationBefore = storage.getGeneration();
		const block = {
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
		};

		// The FIRST corrupt upsert must THROW — the catch branch latches and
		// throws (not silently returns), so the broker handler (server.ts
		// BLOCK_ROUTE) catches it and answers a non-200 response. Without this,
		// the broker's first block upsert encounters corruption, returns
		// normally (HTTP 200), and the remote client's success-refresh
		// overwrites its optimistic local block with a block-free snapshot.
		expect(() => storage.upsertCredentialBlock(block)).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);

		// The second call must also THROW — now via the #storeDamaged guard,
		// before touching SQLite.
		expect(() => storage.upsertCredentialBlock(block)).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);

		// The spy fired exactly once: the first call latched via the catch path;
		// the second call threw before touching SQLite.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(storage.getGeneration()).toBe(generationBefore + 1);
		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Credential store is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
	});

	test("listCredentialBlocks throws after the store is damaged instead of reporting no blocks", async () => {
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "listCredentialBlocks").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		expect(() => storage.listCredentialBlocks([1])).toThrow(/Credential store .* damaged/);
		expect(() => storage.listCredentialBlocks([1])).toThrow(/\.recover/);
	});
});

describe("AuthStorage corrupt-store broker seam", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-broker-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("public upsertCredentialBlock throws when store is latched (broker gets non-200)", async () => {
		// Latch the store via a corrupt read (same path production hits).
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		// Drive credential selection to trigger the latch.
		await storage.getApiKey(PROVIDER, "session-broker-latch");

		// The public/broker-facing seam must throw — not silently return — so
		// the broker handler (server.ts BLOCK_ROUTE) catches it and answers a
		// non-200 response, preserving the remote client's local backoff.
		expect(() =>
			storage.upsertCredentialBlock({
				credentialId: 1,
				providerKey: "anthropic:oauth",
				blockScope: "",
				blockedUntilMs: Date.now() + 60_000,
			}),
		).toThrow("Credential store is damaged; block writes are unavailable");
	});

	test("internal markCredentialBlocked path (via markUsageLimitReached) fails open without throwing", async () => {
		// Set up two credentials so markUsageLimitReached can block one and
		// selection can rotate to the sibling.
		store.saveOAuth(PROVIDER, oauthCredential("2"));
		await storage.reload();

		// Latch the store via a corrupt read.
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(store, "upsertCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		// Trigger the latch.
		await storage.getApiKey(PROVIDER, "session-internal-latch");

		const rows = store.listAuthCredentials(PROVIDER);
		const firstRow = rows[0];
		if (!firstRow) throw new Error("expected first credential row");

		// The internal write path (#markCredentialBlocked, called by
		// markUsageLimitReached) must NOT throw — it short-circuits before
		// touching the store when #storeDamaged is true, keeping the
		// in-memory backoff map intact so within-process selection still
		// honors the block.
		const result = await storage.markUsageLimitReached(PROVIDER, "session-internal", {
			credentialId: firstRow.id,
			retryAfterMs: 60_000,
		});

		// markUsageLimitReached returned normally (no throw) and reported
		// a sibling switch since the second credential is unblocked.
		expect(result.switched).toBe(true);

		// The in-memory block is effective: selection from the SAME session
		// (which has a sticky preference for the first credential from the
		// latch-triggering getApiKey) must skip the blocked first credential
		// and return the sibling — proving the block is real, not just that a
		// fresh session happened to round-robin to the second key.
		const key = await storage.getApiKey(PROVIDER, "session-internal-latch");
		expect(key).toBe("access-2");
	});

	test("first corrupt upsert on unlatched store throws (catch branch), second throws via guard", async () => {
		// On an initially UNLATCHED store, the first corrupt upsert must
		// throw from the catch branch (not silently return after latching),
		// so the broker handler returns a non-200 on the very call that
		// discovered the corruption. The second call throws via the
		// #storeDamaged guard before touching SQLite.
		const malformedDbPath = await writeMalformedDb(tempDir);
		const spy = vi.spyOn(store, "upsertCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		const block = {
			credentialId: 1,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
		};

		// First call: store is NOT latched → hits SQLite → corrupt throw →
		// catch latches and throws (not silent return).
		expect(() => storage.upsertCredentialBlock(block)).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
		// Second call: store IS latched → guard throws before touching SQLite.
		expect(() => storage.upsertCredentialBlock(block)).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
		// The spy fired exactly once: the first call hit SQLite; the second
		// threw via the guard.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	test("public deleteCredentialBlocks throws when store is latched (broker gets non-200)", async () => {
		// Latch the store via a corrupt read.
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		// Drive credential selection to trigger the latch.
		await storage.getApiKey(PROVIDER, "session-delete-latch");

		// The public/broker-facing seam must throw — not silently return — so
		// the broker handler (server.ts BLOCKS_ROUTE DELETE) catches it and
		// answers a non-200 response, preserving the remote client's local
		// blocks instead of letting a success-refresh clear them.
		expect(() => storage.deleteCredentialBlocks(1)).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
	});

	test("first corrupt deleteCredentialBlocks on unlatched store throws (catch branch)", async () => {
		// On an initially UNLATCHED store, the first corrupt delete must
		// throw from the catch branch (not silently return after latching).
		const malformedDbPath = await writeMalformedDb(tempDir);
		const spy = vi.spyOn(store, "deleteCredentialBlocks").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		// First call: store is NOT latched → hits SQLite → corrupt throw →
		// catch latches and throws (not silent return).
		expect(() => storage.deleteCredentialBlocks(1)).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
		// Second call: store IS latched → guard throws before touching SQLite.
		expect(() => storage.deleteCredentialBlocks(1)).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	test("public deleteCredentialBlock throws when store is latched (broker gets non-200)", async () => {
		// Latch the store via a corrupt read.
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		// Drive credential selection to trigger the latch.
		await storage.getApiKey(PROVIDER, "session-delete-singular-latch");

		// The public/broker-facing seam must throw — not silently return — so
		// the broker handler catches it and answers a non-200 response.
		expect(() => storage.deleteCredentialBlock(1, "anthropic:oauth", "")).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
	});

	test("first corrupt deleteCredentialBlock on unlatched store throws (catch branch), second throws via guard", async () => {
		// On an initially UNLATCHED store, the first corrupt delete must
		// throw from the catch branch (not silently return after latching),
		// so the broker handler returns a non-200 on the very call that
		// discovered the corruption. The second call throws via the
		// #storeDamaged guard before touching SQLite.
		const malformedDbPath = await writeMalformedDb(tempDir);
		const spy = vi.spyOn(store, "deleteCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		// First call: store is NOT latched → hits SQLite → corrupt throw →
		// catch latches and throws (not silent return).
		expect(() => storage.deleteCredentialBlock(1, "anthropic:oauth", "")).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
		// Second call: store IS latched → guard throws before touching SQLite.
		expect(() => storage.deleteCredentialBlock(1, "anthropic:oauth", "")).toThrow(
			"Credential store is damaged; block writes are unavailable",
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	test("internal #clearCredentialBlockScope heal path clears in-memory block without surfacing error while latched", async () => {
		// The internal heal path (#clearCredentialBlockScope, called from
		// #healCodexUsageBlockScope after a healthy usage report) calls
		// this.deleteCredentialBlock inside a try/catch with a debug log.
		// Now that deleteCredentialBlock throws when latched, the catch must
		// swallow it so the in-memory backoff clear still proceeds. This test
		// drives the REAL heal flow (not a mirrored try/catch) and asserts both
		// the observable state (block cleared) and the catch-path debug log.
		const HOUR_MS = 60 * 60_000;
		const WEEK_MS = 7 * 24 * HOUR_MS;

		function codexLimit(key: "primary" | "secondary", usedFraction: number): UsageLimit {
			const windowId = key === "primary" ? "1h" : "7d";
			const windowLabel = key === "primary" ? "1 Hour" : "7 Day";
			const durationMs = key === "primary" ? HOUR_MS : WEEK_MS;
			return {
				id: `openai-codex:${key}`,
				label: windowLabel,
				scope: { provider: "openai-codex", windowId, shared: true },
				window: { id: windowId, label: windowLabel, durationMs, resetsAt: Date.now() + durationMs },
				amount: {
					unit: "percent",
					used: usedFraction * 100,
					limit: 100,
					remaining: (1 - usedFraction) * 100,
					usedFraction,
					remainingFraction: 1 - usedFraction,
				},
				status: usedFraction >= 1 ? "exhausted" : "ok",
			};
		}

		function codexReport(accountId: string, email: string, healthy: boolean): UsageReport {
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [codexLimit("primary", 0.2), codexLimit("secondary", 0.3)],
				metadata: { accountId, email, allowed: healthy, limitReached: !healthy, planType: "pro" },
			};
		}

		function codexCredential(accountId: string, email: string): OAuthCredential {
			return {
				type: "oauth",
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + WEEK_MS,
				accountId,
				email,
			};
		}

		const usageByAccount = new Map<string, UsageReport | null>();
		const usageProvider: UsageProvider = {
			id: "openai-codex",
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				if (!accountId) return null;
				return usageByAccount.get(accountId) ?? null;
			},
		};

		// Re-create storage with the usage provider so fetchUsageReports can fan out.
		storage.close();
		store.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});

		await storage.set("openai-codex", [
			codexCredential("acct-blocked", "blocked@example.com"),
			codexCredential("acct-sibling", "sibling@example.com"),
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		const base = Date.now();
		let clockOffset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => base + clockOffset);

		// Block the credential in-memory with a 1-hour backoff.
		await storage.markUsageLimitReached("openai-codex", "heal-scope-session", {
			credentialId: blockedRow.id,
			retryAfterMs: HOUR_MS,
		});

		// Latch the store via a corrupt upsert — the public seam now throws.
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "upsertCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		expect(() =>
			storage.upsertCredentialBlock({
				credentialId: blockedRow.id,
				providerKey: "openai-codex:oauth",
				blockScope: "chat",
				blockedUntilMs: base + HOUR_MS,
			}),
		).toThrow("Credential store is damaged; block writes are unavailable");

		// Verify the credential is blocked: getApiKey should return the sibling.
		const blockedKey = await storage.getApiKey("openai-codex", "heal-scope-verify-blocked");
		expect(blockedKey).toBe("access-acct-sibling");

		// Set up healthy usage reports for both accounts.
		usageByAccount.set("acct-blocked", codexReport("acct-blocked", "blocked@example.com", true));
		usageByAccount.set("acct-sibling", codexReport("acct-sibling", "sibling@example.com", true));

		// Advance time past the 5-minute probe-after window.
		clockOffset = 6 * 60_000;

		// Drive the heal flow: fetchUsageReports → #reconcileCodexUsageBlock →
		// #healCodexUsageBlockScope → #clearCredentialBlockScope →
		// this.deleteCredentialBlock (throws, caught by try/catch, debug-logged).
		await storage.fetchUsageReports();

		// The in-memory block is cleared: the previously blocked credential
		// must be selectable again. This proves #clearCredentialBlockScope's
		// in-memory clear (lines before the try/catch) ran and the catch
		// swallowed the deleteCredentialBlock throw without surfacing it.
		const selections = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const key = await storage.getApiKey("openai-codex", `heal-scope-after-${i}`);
			if (key) selections.add(key);
		}
		expect(selections.has("access-acct-blocked")).toBe(true);

		// The debug log from #clearCredentialBlockScope's catch fired,
		// confirming the deleteCredentialBlock throw was swallowed (not surfaced).
		const clearScopeDebugs = debugSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0] === "Failed to clear persisted credential block",
		);
		expect(clearScopeDebugs.length).toBeGreaterThan(0);
	});
});

describe("AuthStorage corrupt-store reporting", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-report-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("emits exactly one logger.error and no swallow-debug for the corrupt read", async () => {
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

		await storage.getApiKey(PROVIDER, "session-report-1");
		await storage.getApiKey(PROVIDER, "session-report-1");

		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Credential store is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		// The repair guidance must point at the actual store file, not a
		// hardcoded default path (profiles relocate agent.db).
		expect(String(damagedErrors[0]?.[0])).toContain(dbPath);
		expect(String(damagedErrors[0]?.[0])).toContain(sqliteRepairGuidance(dbPath, { restrictPermissions: true }));

		const swallowDebugs = debugSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0] === "Failed to read credential block from persistent store",
		);
		expect(swallowDebugs).toHaveLength(0);
	});
});

describe("AuthStorage corrupt-store generation notification", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-gen-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("F3: onGenerationChanged fires exactly once on the first corrupt error and not on the second", async () => {
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});

		const generations: number[] = [];
		storage.onGenerationChanged(gen => generations.push(gen));
		const generationBefore = storage.getGeneration();

		// First call: hits the store, throws SQLITE_NOTADB, latches, bumps generation.
		await storage.getApiKey(PROVIDER, "session-gen-1");
		// Second call: store is already latched, short-circuits before touching SQLite.
		await storage.getApiKey(PROVIDER, "session-gen-1");

		// F3: the generation listener fires exactly once — only on the first latch.
		expect(generations).toHaveLength(1);
		expect(generations[0]).toBe(generationBefore + 1);
	});
});

describe("AuthStorage corrupt-store shell-balanced repair guidance", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-shell-"));
		// Use a path containing a single quote to exercise shell quoting.
		const quoteDir = path.join(tempDir, "omp's agent");
		await fs.mkdir(quoteDir, { recursive: true });
		const dbPath = path.join(quoteDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("F2: latch message emits a shell-balanced repair command for a quote-containing path", async () => {
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		await storage.getApiKey(PROVIDER, "session-shell-1");

		const damagedCall = errorSpy.mock.calls.find(
			call => typeof call[0] === "string" && call[0].includes("Credential store is damaged"),
		);
		expect(damagedCall).toBeDefined();
		const message = String(damagedCall?.[0]);
		expect(message).toContain("--ignore-freelist");
		const expectedDbPath = path.join(tempDir, "omp's agent", "agent.db");
		expect(message).toContain(sqliteRepairGuidance(expectedDbPath, { restrictPermissions: true }));
		// The repair command must be shell-balanced: every unescaped single
		// quote toggles open/close state, so the string ends closed.
		let open = false;
		for (let i = 0; i < message.length; i++) {
			if (message[i] === "'" && message[i - 1] !== "\\") open = !open;
		}
		expect(open).toBe(false);
	});

	test("F2: damagedStoreError emits a shell-balanced repair command for a quote-containing path", async () => {
		const quoteDir = path.join(tempDir, "omp's agent");
		const dbPath = path.join(quoteDir, "agent.db");
		// Force the static error helper through the open() path by corrupting
		// the file after the store was successfully opened in beforeEach.
		store.close();
		await fs.writeFile(dbPath, "this is not a sqlite database");

		expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toThrow();
		try {
			await SqliteAuthCredentialStore.open(dbPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain(sqliteRepairGuidance(dbPath, { restrictPermissions: true }));
			// Shell-balanced check.
			let open = false;
			for (let i = 0; i < message.length; i++) {
				if (message[i] === "'" && message[i - 1] !== "\\") open = !open;
			}
			expect(open).toBe(false);
		}
	});
});

describe("AuthStorage corrupt-store bump skips acknowledge when latched", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-ack-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("F3: latch bump does not call acknowledgeLocalChanges but listeners still fire", async () => {
		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "getCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});
		const ackSpy = vi.spyOn(store, "acknowledgeLocalChanges");

		const generations: number[] = [];
		storage.onGenerationChanged(gen => generations.push(gen));
		const generationBefore = storage.getGeneration();

		// Trigger the latch: getCredentialBlock throws SQLITE_NOTADB → latch → bump.
		await storage.getApiKey(PROVIDER, "session-ack-1");

		// Mutation proof: acknowledgeLocalChanges must NOT have been called on
		// the latch bump — the store is damaged and acknowledging is meaningless.
		expect(ackSpy).not.toHaveBeenCalled();
		// The generation listener still fired despite the skipped acknowledge.
		expect(generations).toHaveLength(1);
		expect(generations[0]).toBe(generationBefore + 1);
	});

	test("F3: a healthy bump still calls acknowledgeLocalChanges", async () => {
		const ackSpy = vi.spyOn(store, "acknowledgeLocalChanges");

		const generations: number[] = [];
		storage.onGenerationChanged(gen => generations.push(gen));
		const generationBefore = storage.getGeneration();

		// A normal credential save + reload triggers a healthy bump (no latch).
		store.saveApiKey(PROVIDER, "sk-healthy-bump-test");
		await storage.reload();

		expect(ackSpy).toHaveBeenCalled();
		expect(generations).toHaveLength(1);
		expect(generations[0]).toBe(generationBefore + 1);
	});
});
describe("AuthStorage corrupt-store heal while latched", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	const HOUR_MS = 60 * 60 * 1000;
	const WEEK_MS = 7 * 24 * HOUR_MS;

	function codexLimit(key: "primary" | "secondary", usedFraction: number): UsageLimit {
		const windowId = key === "primary" ? "1h" : "7d";
		const windowLabel = key === "primary" ? "1 Hour" : "7 Day";
		const durationMs = key === "primary" ? HOUR_MS : WEEK_MS;
		return {
			id: `openai-codex:${key}`,
			label: windowLabel,
			scope: { provider: "openai-codex", windowId, shared: true },
			window: {
				id: windowId,
				label: windowLabel,
				durationMs,
				resetsAt: Date.now() + durationMs,
			},
			amount: {
				unit: "percent",
				used: usedFraction * 100,
				limit: 100,
				remaining: (1 - usedFraction) * 100,
				usedFraction,
				remainingFraction: 1 - usedFraction,
			},
			status: usedFraction >= 1 ? "exhausted" : "ok",
		};
	}

	function codexReport(
		accountId: string,
		email: string,
		primaryUsed: number,
		secondaryUsed: number,
		healthy: boolean,
	): UsageReport {
		return {
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [codexLimit("primary", primaryUsed), codexLimit("secondary", secondaryUsed)],
			metadata: {
				accountId,
				email,
				allowed: healthy,
				limitReached: !healthy,
				planType: "pro",
			},
		};
	}

	function codexCredential(accountId: string, email: string): OAuthCredential {
		return {
			type: "oauth",
			access: `access-${accountId}`,
			refresh: `refresh-${accountId}`,
			expires: Date.now() + WEEK_MS,
			accountId,
			email,
		};
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-heal-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("F1: healthy usage report clears in-memory Codex block while store is latched", async () => {
		const usageByAccount = new Map<string, UsageReport | null>();
		const usageProvider: UsageProvider = {
			id: "openai-codex",
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				if (!accountId) return null;
				return usageByAccount.get(accountId) ?? null;
			},
		};

		// Re-create storage with the usage provider so fetchUsageReports can fan out.
		storage.close();
		store.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});

		await storage.set("openai-codex", [
			codexCredential("acct-blocked", "blocked@example.com"),
			codexCredential("acct-sibling", "sibling@example.com"),
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		// Start with no usage reports — markUsageLimitReached will use retryAfterMs.
		const base = Date.now();
		let clockOffset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => base + clockOffset);

		// Block the credential in-memory with a 1-hour backoff.
		// With no usage report, blockedUntil = now + retryAfterMs.
		// probeAfter = min(blockedUntil, now + 5min TTL) = now + 5min.
		await storage.markUsageLimitReached("openai-codex", "heal-session", {
			credentialId: blockedRow.id,
			retryAfterMs: HOUR_MS,
		});

		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "upsertCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});
		// Latch the store via a corrupt upsert — the public seam now throws
		// (catch branch latches and throws, not silent return).
		expect(() =>
			storage.upsertCredentialBlock({
				credentialId: blockedRow.id,
				providerKey: "openai-codex:oauth",
				blockScope: "chat",
				blockedUntilMs: base + HOUR_MS,
			}),
		).toThrow("Credential store is damaged; block writes are unavailable");

		// Verify the credential is blocked: getApiKey should return the sibling.
		const blockedKey = await storage.getApiKey("openai-codex", "heal-verify-blocked");
		expect(blockedKey).toBe("access-acct-sibling");

		// Set up a healthy usage report for the blocked account.
		usageByAccount.set("acct-blocked", codexReport("acct-blocked", "blocked@example.com", 0.2, 0.3, true));
		usageByAccount.set("acct-sibling", codexReport("acct-sibling", "sibling@example.com", 0.2, 0.3, true));

		// Advance time past the 5-minute probe-after window.
		clockOffset = 6 * 60 * 1000;

		// Drive the heal path: fetchUsageReports fans out per-credential,
		// each report triggers #reconcileCodexUsageBlock → #healCodexUsageBlockScope.
		await storage.fetchUsageReports();

		// The in-memory block should now be cleared. With both credentials
		// unblocked, the previously blocked one must be selectable.
		const selections = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const key = await storage.getApiKey("openai-codex", `heal-after-${i}`);
			if (key) selections.add(key);
		}
		expect(selections.has("access-acct-blocked")).toBe(true);
	});

	test("F7: redeeming a reset clears the in-memory block when persistence is damaged", async () => {
		const usageFetch = Object.assign(
			async (input: string | URL | Request) => {
				if (String(input).endsWith("/rate-limit-reset-credits/consume")) {
					return Response.json({ code: "reset" });
				}
				throw new Error(`unexpected reset-credit request: ${String(input)}`);
			},
			{ preconnect: fetch.preconnect },
		);
		storage.close();
		store.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store, { usageFetch });
		await storage.set("openai-codex", [
			codexCredential("acct-blocked", "blocked@example.com"),
			codexCredential("acct-sibling", "sibling@example.com"),
		]);
		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		await storage.markUsageLimitReached("openai-codex", "reset-session", {
			credentialId: blockedRow.id,
			retryAfterMs: HOUR_MS,
		});
		const blockedKey = await storage.getApiKey("openai-codex", "reset-before");
		expect(blockedKey).toBe("access-acct-sibling");

		const malformedDbPath = await writeMalformedDb(tempDir);
		vi.spyOn(store, "upsertCredentialBlock").mockImplementation(() => {
			throw realCorruptError(malformedDbPath);
		});
		vi.spyOn(logger, "error").mockImplementation(() => {});
		expect(() =>
			storage.upsertCredentialBlock({
				credentialId: blockedRow.id,
				providerKey: "openai-codex:oauth",
				blockScope: "",
				blockedUntilMs: Date.now() + HOUR_MS,
			}),
		).toThrow("Credential store is damaged; block writes are unavailable");

		const redeemed = await storage.redeemResetCredit({
			target: { credentialId: blockedRow.id },
			creditId: "RateLimitResetCredit_test",
		});
		expect(redeemed).toMatchObject({ ok: true, code: "reset", creditId: "RateLimitResetCredit_test" });
		const selections = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const key = await storage.getApiKey("openai-codex", `reset-after-${i}`);
			if (key) selections.add(key);
		}
		expect(selections.has("access-acct-blocked")).toBe(true);
	});
});

describe("SqliteAuthCredentialStore corrupt-store open guidance", () => {
	test("F4: open(malformedPath) rejects with .recover and the path", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-corrupt-open-"));
		try {
			const malformedDbPath = await writeMalformedDb(tempDir);
			expect(SqliteAuthCredentialStore.open(malformedDbPath)).rejects.toThrow();
			try {
				await SqliteAuthCredentialStore.open(malformedDbPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				expect(message).toContain(".recover");
				expect(message).toContain(malformedDbPath);
				expect(message).toContain("--ignore-freelist");
			}
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
