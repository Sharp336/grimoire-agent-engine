/**
 * Regression coverage for issue #2421.
 *
 * Concurrent omp startups can race against WAL recovery so the auth-store init
 * sees `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` before its multi-statement run
 * installs the busy handler. The fix hoists `PRAGMA busy_timeout` to a separate
 * statement that runs first and wraps `open()` in a bounded retry loop on the
 * BUSY family.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSqliteBusyError, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

interface SqliteBusyShape extends Error {
	code: string;
	errno: number;
}

function makeBusyError(code: string, errno: number): SqliteBusyShape {
	const err = new Error("database is locked") as SqliteBusyShape;
	err.code = code;
	err.errno = errno;
	return err;
}

describe("isSqliteBusyError", () => {
	test("recognizes every documented BUSY family code", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY", 5))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_RECOVERY", 261))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_SNAPSHOT", 517))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_TIMEOUT", 773))).toBe(true);
	});

	test("rejects non-BUSY codes and non-error values", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_LOCKED", 6))).toBe(false);
		expect(isSqliteBusyError(makeBusyError("SQLITE_CORRUPT", 11))).toBe(false);
		expect(isSqliteBusyError(new Error("plain"))).toBe(false);
		expect(isSqliteBusyError(null)).toBe(false);
		expect(isSqliteBusyError(undefined)).toBe(false);
		expect(isSqliteBusyError("SQLITE_BUSY")).toBe(false);
	});
});

describe("SqliteAuthCredentialStore.open SQLITE_BUSY handling", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-sqlite-busy-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("installs busy_timeout BEFORE any lock-taking statement", async () => {
		// Spy on `Database.prototype.run` to record every SQL statement `open()`
		// issues, in call order. The fix's invariant is that the busy handler
		// (`PRAGMA busy_timeout = 5000`) runs before the first lock-taking DDL
		// (`CREATE TABLE IF NOT EXISTS auth_credential_refresh_leases`), so
		// assert the pragma appears at a strictly lower call index than that DDL.
		const realRun = Database.prototype.run;
		const runStatements: string[] = [];
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			const sql = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
			runStatements.push(sql);
			return realRun.apply(this, args);
		});

		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			const busyTimeoutIndex = runStatements.findIndex(s => s.includes("PRAGMA busy_timeout = 5000"));
			const leasesDdlIndex = runStatements.findIndex(s =>
				s.includes("CREATE TABLE IF NOT EXISTS auth_credential_refresh_leases"),
			);
			expect(busyTimeoutIndex).toBeGreaterThanOrEqual(0);
			expect(leasesDdlIndex).toBeGreaterThanOrEqual(0);
			// The busy handler MUST be installed before the first lock-taking DDL.
			expect(busyTimeoutIndex).toBeLessThan(leasesDdlIndex);
		} finally {
			store.close();
		}
	});

	test("retries through a transient SQLITE_BUSY_RECOVERY and eventually succeeds", async () => {
		const dbPath = path.join(tempDir, "retry.db");
		let throws = 2;
		// Synthesize the WAL-recovery race: the first two `db.run` calls in
		// `open()` (the first being `PRAGMA busy_timeout = 5000`) throw
		// `SQLITE_BUSY_RECOVERY`, then the third attempt sees the spy drained
		// and falls through to the real implementation.
		const realRun = Database.prototype.run;
		const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			if (throws > 0) {
				throws--;
				throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
			}
			return realRun.apply(this, args);
		});

		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(throws).toBe(0);
			expect(spy).toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	test("non-BUSY errors short-circuit retries", async () => {
		const dbPath = path.join(tempDir, "fatal.db");
		const realRun = Database.prototype.run;
		let runCalls = 0;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			runCalls++;
			if (runCalls === 1) {
				const err = new Error("disk image malformed") as SqliteBusyShape;
				err.code = "SQLITE_CORRUPT";
				err.errno = 11;
				throw err;
			}
			return realRun.apply(this, args);
		});

		await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toThrow("disk image malformed");
		// Single attempt: the retry loop must NOT keep banging on a fatal error.
		expect(runCalls).toBe(1);
	});

	test("exhausts retries and surfaces an error that includes the DB path", async () => {
		const dbPath = path.join(tempDir, "stuck.db");
		const realRun = Database.prototype.run;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database) {
			// Always-busy: every attempt fails until the retry budget runs out.
			throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
		});
		// Skip the sleep so the test doesn't take 700ms+ of real time.
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);

		await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toThrow(dbPath);
		// open uses `maxAttempts = 4`, so the loop sleeps between attempts 0..2
		// (three times) then throws after attempt 3 without sleeping again.
		expect(sleepSpy).toHaveBeenCalledTimes(3);
		// Reference realRun so the TS unused-binding lint stays quiet without
		// suppressing the actual error path above.
		expect(typeof realRun).toBe("function");
	});
});
