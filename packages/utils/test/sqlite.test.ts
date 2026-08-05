import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	configureSqliteDatabase,
	isSqliteBusyError,
	isSqliteCorruptError,
	openSqliteDatabase,
	type SqliteOpenSettings,
	sqliteRepairGuidance,
} from "../src/sqlite";
import { removeWithRetries } from "../src/temp";

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
/**
 * Contract tests for the shared SQLite opener.
 *
 * The load-bearing invariant (issue #2421): the busy handler is installed
 * BEFORE the first lock-taking statement, so a concurrent WAL recovery or
 * checkpoint makes a connection wait instead of throwing SQLITE_BUSY. The
 * opener is also total at the resource boundary: a pragma failure closes the
 * fresh handle before the error propagates.
 */

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
		const guidance = sqliteRepairGuidance(dbPath, { platform: "linux", restrictPermissions: true });
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
		const guidance = sqliteRepairGuidance("/tmp/model cache.db", { platform: "linux" });
		expect(guidance).not.toContain("umask 077");
		expect(guidance).toContain("PRAGMA integrity_check");
		expect(guidance).toContain("mv '/tmp/model cache.db.fixed' '/tmp/model cache.db'");
	});

	test("keeps the path-free fallback", () => {
		const fallback = "Repair the store file with sqlite3's .recover and restart.";
		expect(sqliteRepairGuidance(undefined, { platform: "linux" })).toBe(fallback);
		expect(sqliteRepairGuidance(undefined, { platform: "win32" })).toBe(fallback);
	});

	test("emits POSIX guidance for every non-Windows platform", () => {
		const guidance = sqliteRepairGuidance("/tmp/model cache.db", { platform: "darwin" });
		expect(guidance).not.toContain("PowerShell");
		expect(guidance).toContain("grep -qx 'ok'");
		expect(guidance).toContain("mv '/tmp/model cache.db.fixed' '/tmp/model cache.db'");
	});

	test("builds guarded PowerShell repair guidance with quoted paths", () => {
		const dbPath = "C:\\Users\\A O'Brien\\agent.db";
		const guidance = sqliteRepairGuidance(dbPath, { platform: "win32" });
		const quotedPath = "'C:\\Users\\A O''Brien\\agent.db'";
		const fixedPath = "'C:\\Users\\A O''Brien\\agent.db.fixed'";
		const walPath = "'C:\\Users\\A O''Brien\\agent.db-wal'";
		const backupWalPath = "'C:\\Users\\A O''Brien\\agent.db.bak-wal'";
		const shmPath = "'C:\\Users\\A O''Brien\\agent.db-shm'";
		const backupShmPath = "'C:\\Users\\A O''Brien\\agent.db.bak-shm'";

		expect(guidance).toContain("in PowerShell");
		expect(guidance).toContain(`sqlite3 ${quotedPath} '.recover --ignore-freelist' | sqlite3 ${fixedPath}`);
		expect(guidance).toContain("$LASTEXITCODE -eq 0 -and");
		expect(guidance.indexOf("$LASTEXITCODE -eq 0 -and")).toBeLessThan(guidance.indexOf("Move-Item"));
		expect(guidance).toContain(`Move-Item -Force ${fixedPath} ${quotedPath}`);
		expect(guidance).toContain(`Move-Item -Force -ErrorAction SilentlyContinue ${walPath} ${backupWalPath}`);
		expect(guidance).toContain(`Move-Item -Force -ErrorAction SilentlyContinue ${shmPath} ${backupShmPath}`);
		expect(guidance).not.toContain("umask");
	});

	test("adds ACL hardening only for restricted PowerShell repair", () => {
		const dbPath = "C:\\Users\\me\\agent.db";
		const restricted = sqliteRepairGuidance(dbPath, { platform: "win32", restrictPermissions: true });
		const plain = sqliteRepairGuidance(dbPath, { platform: "win32" });
		const hardening = `icacls '${dbPath}' /inheritance:r /grant:r ("{0}\\{1}:(F)" -f $env:USERDOMAIN, $env:USERNAME) | Out-Null`;

		expect(restricted).toContain(hardening);
		expect(plain).not.toContain("icacls");
		expect(restricted.indexOf(hardening)).toBeGreaterThan(restricted.indexOf(`Move-Item -Force '${dbPath}.fixed'`));
	});
});
