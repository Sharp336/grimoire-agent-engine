import { type Changes, Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { restoreBackup } from "@oh-my-pi/pi-mnemopi/dr/recovery";

// Contract (issue #2421): the busy handler must be installed BEFORE any
// lock-taking statement. writeGzippedSqlDump opened its recovery scratch db
// with NO pragmas and then replayed a .dump stream of lock-taking DDL. This
// test drives restoreBackup with a gzipped SQL dump (which routes through
// writeGzippedSqlDump) and proves busy_timeout is installed first. WAL is
// deliberately NOT set on the scratch db: it is short-lived and renamed into
// place, so WAL would orphan -wal/-shm sidecars beside the temp path.

const tempDirs: string[] = [];
const EMPTY_CHANGES: Changes = { changes: 0, lastInsertRowid: 0 };

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recovery writeGzippedSqlDump pragma order", () => {
	it("installs busy_timeout before replaying the dump and does not set WAL", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemopi-recovery-pragma-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "agent.db");
		const backupPath = join(dir, "dump.sql.gz");
		// A gzipped SQL dump (not a sqlite file) routes through writeGzippedSqlDump.
		writeFileSync(backupPath, gzipSync(Buffer.from("CREATE TABLE x (id INTEGER PRIMARY KEY);")));

		const statements: string[] = [];
		vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql: string): Changes {
			statements.push(sql);
			return EMPTY_CHANGES;
		});
		vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string): Changes {
			statements.push(sql);
			return EMPTY_CHANGES;
		});

		const result = restoreBackup(backupPath, dbPath);
		expect(result.restored).toBe(true);

		// busy_timeout is the very first statement issued on the scratch handle.
		expect(statements[0]).toBe("PRAGMA busy_timeout = 5000");
		// WAL is not set on the transient recovery db.
		expect(statements.some(s => /journal_mode/i.test(s))).toBe(false);
		// The dumped DDL is replayed after the busy handler.
		const firstDdl = statements.findIndex(s => /CREATE TABLE/i.test(s));
		expect(firstDdl).toBeGreaterThan(0);
	});
});
