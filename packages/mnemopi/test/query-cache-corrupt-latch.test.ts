/**
 * Regression coverage for the QueryCache corrupt-persistence latch.
 *
 * QueryCache backs its cross-process persistence with a SQLite handle
 * (`#conn`). Before the latch, every persistence error — including the
 * unrecoverable SQLITE_CORRUPT / SQLITE_NOTADB family — was swallowed at
 * `debug`-equivalent silence and the connection kept being reused, so a
 * damaged `query_cache.db` was re-queried on every put, every hit update,
 * and every eviction for the life of the process.
 *
 * The fix latches the persistence layer as damaged on the first
 * unrecoverable error: closes the handle, clears `#conn` so no later code
 * path touches SQLite, reports once at `error` level, and falls through to
 * the existing in-memory behavior. Non-corrupt errors keep their exact
 * current handling.
 */

import { type Changes, Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryCache } from "@oh-my-pi/pi-mnemopi/core/query-cache";
import { logger } from "@oh-my-pi/pi-utils";
import { isSqliteCorruptError } from "@oh-my-pi/pi-utils/sqlite";

const EMPTY_CHANGES: Changes = { changes: 0, lastInsertRowid: 0 };

const tempDirs: string[] = [];
const openCaches: QueryCache[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const cache of openCaches.splice(0)) cache.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes a deterministic malformed SQLite source — bytes that are not a valid
 * SQLite database — and returns the path. Opening this with `new Database(path)`
 * and running a query makes bun:sqlite throw a real `SQLiteError` carrying
 * `code: "SQLITE_NOTADB"` (errno 26), the same family the latch classifies.
 */
function writeMalformedDb(dir: string): string {
	const dbPath = join(dir, "malformed.db");
	writeFileSync(dbPath, "this is not a sqlite database");
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
	throw new Error("expected SQLITE_NOTADB from malformed database");
}

describe("QueryCache corrupt-persistence latch", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mnemopi-qc-corrupt-"));
		tempDirs.push(dir);
		dbPath = join(dir, "query_cache.db");
	});

	test("latches after one corrupt write and stops re-querying the store", () => {
		const malformedDbPath = writeMalformedDb(dir);
		const corruptErr = realCorruptError(malformedDbPath);
		expect(isSqliteCorruptError(corruptErr)).toBe(true);

		// Build a valid cache first so the constructor (schema DDL + load) succeeds.
		const cache = new QueryCache({ dbPath, maxSize: 10 });
		openCaches.push(cache);
		// Populate the in-memory tiers so we can prove recall still works after latch.
		cache.put("hello world", [{ id: 1, text: "result" }]);

		// Now corrupt the connection: spy on Database.prototype.run so the next
		// persistence write throws the REAL SQLITE_NOTADB error that production
		// sees when query_cache.db is damaged. The spy throws once, then restores
		// real behavior so we can prove the latch prevents further SQLite calls.
		let throwNext = true;
		const runSpy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			sql: string,
			..._args: unknown[]
		): Changes {
			if (throwNext && sql.startsWith("INSERT OR REPLACE INTO query_cache")) {
				throwNext = false;
				throw corruptErr;
			}
			return EMPTY_CHANGES;
		});

		// Drive a persistence write. The first put hits the spy, throws
		// SQLITE_NOTADB, and latches #persistenceDamaged. The put still
		// populates in-memory tiers (they are set before #putPersistent runs).
		cache.put("second query", [{ id: 2, text: "result2" }]);

		// In-memory recall of the latched put still works.
		expect(cache.get("second query")).toEqual([{ id: 2, text: "result2" }]);
		// A get on the first entry triggers #recordPersistentHit (hit-update path),
		// which must short-circuit without touching SQLite.
		const recalled = cache.get("hello world");
		expect(recalled).toEqual([{ id: 1, text: "result" }]);

		// Drive more operations that would normally touch persistence.
		cache.put("third query", [{ id: 3, text: "result3" }]);
		// invalidate touches persistence too — must be a no-op on the latched conn.
		cache.invalidate();

		// The spy was called exactly once for the INSERT (the corrupt write).
		// After the latch, #putPersistent and #recordPersistentHit short-circuit
		// before calling conn.run, so no further INSERT/UPDATE calls reach the spy.
		const insertCalls = runSpy.mock.calls.filter(call => {
			const sql = call[0];
			return typeof sql === "string" && sql.startsWith("INSERT OR REPLACE INTO query_cache");
		});
		expect(insertCalls).toHaveLength(1);

		// No UPDATE calls reached the spy either (hit-update path is latched).
		const updateCalls = runSpy.mock.calls.filter(call => {
			const sql = call[0];
			return typeof sql === "string" && sql.startsWith("UPDATE query_cache");
		});
		expect(updateCalls).toHaveLength(0);
	});

	test("emits exactly one logger.error for the corrupt write", () => {
		const malformedDbPath = writeMalformedDb(dir);
		const corruptErr = realCorruptError(malformedDbPath);

		const cache = new QueryCache({ dbPath, maxSize: 10 });
		openCaches.push(cache);
		cache.put("hello world", [{ id: 1, text: "result" }]);

		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		vi.spyOn(logger, "debug").mockImplementation(() => {});

		let throwNext = true;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			sql: string,
			..._args: unknown[]
		): Changes {
			if (throwNext && sql.startsWith("INSERT OR REPLACE INTO query_cache")) {
				throwNext = false;
				throw corruptErr;
			}
			return EMPTY_CHANGES;
		});

		// First put triggers the corrupt error and latches.
		cache.put("second query", [{ id: 2, text: "result2" }]);
		// Second put is latched — no error, no SQLite.
		cache.put("third query", [{ id: 3, text: "result3" }]);

		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Query-cache persistence store is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		// The error message names the db path.
		expect(String(damagedErrors[0]?.[0])).toContain(dbPath);
	});

	test("non-corrupt errors keep their current best-effort handling", () => {
		const cache = new QueryCache({ dbPath, maxSize: 10 });
		openCaches.push(cache);
		cache.put("hello world", [{ id: 1, text: "result" }]);

		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// Inject a non-corrupt error (SQLITE_BUSY) — the latch must NOT fire.
		const busyErr = new Error("database is locked") as Error & { code: string };
		busyErr.code = "SQLITE_BUSY";
		expect(isSqliteCorruptError(busyErr)).toBe(false);

		let throwNext = true;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			sql: string,
			..._args: unknown[]
		): Changes {
			if (throwNext && sql.startsWith("INSERT OR REPLACE INTO query_cache")) {
				throwNext = false;
				throw busyErr;
			}
			return EMPTY_CHANGES;
		});

		// The put swallows the BUSY error (best-effort) and does NOT latch.
		cache.put("second query", [{ id: 2, text: "result2" }]);

		// No logger.error fired — non-corrupt errors are silent (current behavior).
		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Query-cache persistence store is damaged"),
		);
		expect(damagedErrors).toHaveLength(0);

		// The connection is still active: a subsequent put reaches SQLite again.
		let reachedRun = false;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			sql: string,
			..._args: unknown[]
		): Changes {
			if (sql.startsWith("INSERT OR REPLACE INTO query_cache")) {
				reachedRun = true;
			}
			return EMPTY_CHANGES;
		});
		cache.put("third query", [{ id: 3, text: "result3" }]);
		expect(reachedRun).toBe(true);
	});

	test("invalidate as the first corrupt-touching operation latches without throwing", () => {
		const malformedDbPath = writeMalformedDb(dir);
		const corruptErr = realCorruptError(malformedDbPath);

		const cache = new QueryCache({ dbPath, maxSize: 10 });
		openCaches.push(cache);
		cache.put("hello world", [{ id: 1, text: "result" }]);

		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// Spy so the very first SQLite call — the DELETE FROM query_cache issued
		// by invalidate() — throws the real SQLITE_NOTADB error. No prior put or
		// hit-update has touched SQLite yet, so this is the first corrupt contact.
		let throwNext = true;
		const runSpy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			sql: string,
			..._args: unknown[]
		): Changes {
			if (throwNext && sql.startsWith("DELETE FROM query_cache")) {
				throwNext = false;
				throw corruptErr;
			}
			return EMPTY_CHANGES;
		});

		// invalidate() must NOT throw — the corrupt DELETE is caught and latched.
		expect(() => cache.invalidate()).not.toThrow();

		// Exactly one logger.error fired, naming the db path.
		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Query-cache persistence store is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		expect(String(damagedErrors[0]?.[0])).toContain(dbPath);

		// The latch cleared the connection: a subsequent put must not reach SQLite.
		let reachedInsert = false;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			sql: string,
			..._args: unknown[]
		): Changes {
			if (sql.startsWith("INSERT OR REPLACE INTO query_cache")) {
				reachedInsert = true;
			}
			return EMPTY_CHANGES;
		});
		cache.put("after invalidate", [{ id: 2, text: "result2" }]);
		expect(reachedInsert).toBe(false);

		// The original DELETE spy was called exactly once (the corrupt invalidate).
		// After re-spying, the old mock.calls are gone, so check via the first spy.
		const deleteCalls = runSpy.mock.calls.filter(call => {
			const sql = call[0];
			return typeof sql === "string" && sql.startsWith("DELETE FROM query_cache");
		});
		expect(deleteCalls).toHaveLength(1);

		// In-memory tiers were cleared by invalidate, but the post-latch put works.
		expect(cache.get("after invalidate")).toEqual([{ id: 2, text: "result2" }]);
	});

	test("construction over a malformed db file latches without throwing", () => {
		// Write invalid bytes to a real .db path — this is the common real-world
		// case: query_cache.db is already damaged when the process starts.
		const malformedDbPath = writeMalformedDb(dir);

		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// The constructor must NOT throw — it latches and degrades to in-memory.
		let cache: QueryCache;
		expect(() => {
			cache = new QueryCache({ dbPath: malformedDbPath, maxSize: 10 });
			openCaches.push(cache);
		}).not.toThrow();

		// Exactly one logger.error fired, naming the malformed db path.
		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Query-cache persistence store is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		expect(String(damagedErrors[0]?.[0])).toContain(malformedDbPath);

		// In-memory put/get works without touching SQLite.
		cache!.put("hello world", [{ id: 1, text: "result" }]);
		expect(cache!.get("hello world")).toEqual([{ id: 1, text: "result" }]);

		// No persistence handle is used: spy on Database.prototype.run and
		// confirm no INSERT/UPDATE/DELETE reaches it after construction.
		let reachedRun = false;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			sql: string,
			..._args: unknown[]
		): Changes {
			if (typeof sql === "string" && /INSERT|UPDATE|DELETE/i.test(sql)) {
				reachedRun = true;
			}
			return EMPTY_CHANGES;
		});
		cache!.put("second query", [{ id: 2, text: "result2" }]);
		cache!.get("hello world");
		cache!.invalidate();
		expect(reachedRun).toBe(false);
	});
});
