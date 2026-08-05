/**
 * Contract tests for the shared SQLite opener.
 *
 * The load-bearing invariant (issue #2421): the busy handler is installed
 * BEFORE the first lock-taking statement, so a concurrent WAL recovery or
 * checkpoint makes a connection wait instead of throwing SQLITE_BUSY. The
 * opener is also total at the resource boundary: a pragma failure closes the
 * fresh handle before the error propagates.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	configureSqliteDatabase,
	isSqliteCorruptError,
	openSqliteDatabase,
	type SqliteOpenSettings,
	sqliteRepairGuidance,
} from "@oh-my-pi/pi-utils/sqlite";
import { removeWithRetries } from "../src/temp";

describe("configureSqliteDatabase", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-sqlite-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("installs the busy handler before journal_mode = WAL", () => {
		const db = new Database(path.join(tempDir, "order.db"));
		try {
			const statements: string[] = [];
			const originalRun = db.run.bind(db);
			vi.spyOn(db, "run").mockImplementation((sql: string, ...params: unknown[]) => {
				statements.push(sql);
				return originalRun(sql, ...(params as never[]));
			});

			configureSqliteDatabase(db, { wal: true, synchronousNormal: true, foreignKeys: true });

			const busyIndex = statements.findIndex(s => s.startsWith("PRAGMA busy_timeout"));
			const walIndex = statements.findIndex(s => s.startsWith("PRAGMA journal_mode"));
			expect(busyIndex).toBe(0);
			expect(walIndex).toBeGreaterThan(busyIndex);
		} finally {
			db.close();
		}
	});

	test("applies the named pragmas with the requested timeout", () => {
		const db = new Database(path.join(tempDir, "pragmas.db"));
		try {
			configureSqliteDatabase(db, {
				busyTimeoutMs: 3000,
				foreignKeys: true,
				secureDelete: true,
				wal: true,
				synchronousNormal: true,
			});
			expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 3000 });
			expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
			expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
			expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
			expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
		} finally {
			db.close();
		}
	});

	test("rejects timeouts outside the sqlite3_busy_timeout(int) contract", () => {
		const db = new Database(path.join(tempDir, "bounds.db"));
		try {
			for (const bad of [-1, 1.5, Number.NaN, 2_147_483_648]) {
				expect(() => configureSqliteDatabase(db, { busyTimeoutMs: bad })).toThrow(RangeError);
			}
			// The boundaries themselves are valid.
			configureSqliteDatabase(db, { busyTimeoutMs: 0 });
			configureSqliteDatabase(db, { busyTimeoutMs: 2_147_483_647 });
			expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 2_147_483_647 });
		} finally {
			db.close();
		}
	});

	test("open-only settings cannot flow into configure (compile-time contract)", () => {
		const db = new Database(path.join(tempDir, "types.db"));
		try {
			const openSettings: SqliteOpenSettings = { readonly: true, wal: true };
			// @ts-expect-error readonly is an open-only option; configure rejects it
			configureSqliteDatabase(db, openSettings);
			// The pragma subset still flows when only pragma fields are set.
			configureSqliteDatabase(db, { wal: openSettings.wal });
			expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		} finally {
			db.close();
		}
	});
});

describe("openSqliteDatabase", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-sqlite-open-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("returns a fully configured live connection", () => {
		const db = openSqliteDatabase(path.join(tempDir, "live.db"), { wal: true });
		try {
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			db.run("INSERT INTO t VALUES (1)");
			expect(db.query("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
			expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
			expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
		} finally {
			db.close();
		}
	});

	test("closes the fresh handle before rethrowing a pragma failure", () => {
		const closeSpy = vi.spyOn(Database.prototype, "close");
		expect(() => openSqliteDatabase(path.join(tempDir, "doomed.db"), { busyTimeoutMs: -1 })).toThrow(RangeError);
		expect(closeSpy).toHaveBeenCalledTimes(1);
	});

	test("does not create the parent directory", () => {
		const nested = path.join(tempDir, "missing", "dir", "nope.db");
		expect(() => openSqliteDatabase(nested)).toThrow();
	});

	test("opens an existing database read-only", () => {
		const dbPath = path.join(tempDir, "ro.db");
		const writer = openSqliteDatabase(dbPath, { wal: true });
		writer.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
		writer.close();

		const reader = openSqliteDatabase(dbPath, { readonly: true, busyTimeoutMs: 3000 });
		try {
			expect(reader.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 3000 });
			expect(reader.query("SELECT name FROM sqlite_master WHERE name = 't'").get()).toEqual({ name: "t" });
		} finally {
			reader.close();
		}
	});
});

describe("isSqliteCorruptError", () => {
	test("matches the CORRUPT family and NOTADB, rejects everything else", () => {
		const withCode = (code: string) => Object.assign(new Error("x"), { code });
		expect(isSqliteCorruptError(withCode("SQLITE_CORRUPT"))).toBe(true);
		expect(isSqliteCorruptError(withCode("SQLITE_CORRUPT_VTAB"))).toBe(true);
		expect(isSqliteCorruptError(withCode("SQLITE_NOTADB"))).toBe(true);
		expect(isSqliteCorruptError(withCode("SQLITE_BUSY"))).toBe(false);
		expect(isSqliteCorruptError(new Error("plain"))).toBe(false);
		expect(isSqliteCorruptError(null)).toBe(false);
		expect(isSqliteCorruptError("SQLITE_CORRUPT")).toBe(false);
	});
});

describe("sqliteRepairGuidance", () => {
	test("builds restrictive in-place repair guidance with balanced quoting", () => {
		const dbPath = "/tmp/omp agent's.db";
		const guidance = sqliteRepairGuidance(dbPath, { restrictPermissions: true });
		const quotedPath = "'/tmp/omp agent'\\''s.db'";
		const fixedPath = "'/tmp/omp agent'\\''s.db.fixed'";
		const backupPath = "'/tmp/omp agent'\\''s.db.bak'";

		expect(guidance).toContain(
			`Stop omp, then repair the database in place with: (umask 077 && sqlite3 ${quotedPath}`,
		);
		expect(guidance).toContain(`.recover --ignore-freelist' | sqlite3 ${fixedPath}`);
		let open = false;
		for (let index = guidance.indexOf("(umask 077 &&"); index < guidance.length; index++) {
			if (guidance[index] === "'" && guidance[index - 1] !== "\\") open = !open;
		}
		expect(open).toBe(false);
		expect(guidance.indexOf("(umask 077 &&")).toBeLessThan(
			guidance.indexOf(`sqlite3 ${fixedPath} 'PRAGMA integrity_check'`),
		);
		expect(guidance.indexOf(`sqlite3 ${fixedPath} 'PRAGMA integrity_check'`)).toBeLessThan(
			guidance.indexOf(`mv ${quotedPath} ${backupPath}`),
		);
		expect(guidance.endsWith(`mv ${fixedPath} ${quotedPath}`)).toBe(true);
	});

	test("does not add a restrictive umask to non-secret repair guidance", () => {
		const guidance = sqliteRepairGuidance("/tmp/model cache.db");
		expect(guidance).not.toContain("umask 077");
		expect(guidance).toContain("PRAGMA integrity_check");
		expect(guidance).toContain("mv '/tmp/model cache.db.fixed' '/tmp/model cache.db'");
	});

	test("keeps the path-free fallback", () => {
		expect(sqliteRepairGuidance(undefined)).toBe("Repair the store file with sqlite3's .recover and restart.");
	});
});
