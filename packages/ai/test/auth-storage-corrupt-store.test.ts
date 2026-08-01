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
import { logger } from "@oh-my-pi/pi-utils";
import { isSqliteCorruptError } from "@oh-my-pi/pi-utils/sqlite";
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

		storage.upsertCredentialBlock(block);
		storage.upsertCredentialBlock(block);

		// The first corrupt write latches; the second call short-circuits
		// before touching SQLite, and the invalidation/generation side effects
		// are skipped — a latched write is a true no-op, not a swallowed error.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(storage.getGeneration()).toBe(generationBefore);
		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Credential store is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
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

		const swallowDebugs = debugSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0] === "Failed to read credential block from persistent store",
		);
		expect(swallowDebugs).toHaveLength(0);
	});
});
