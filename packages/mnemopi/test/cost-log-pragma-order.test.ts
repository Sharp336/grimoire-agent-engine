import { type Changes, Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCostLog } from "@oh-my-pi/pi-mnemopi/core/cost-log";

// Contract (issue #2421): the busy handler must be installed BEFORE any
// lock-taking statement. getConn previously opened with NO pragmas at all,
// so the CREATE TABLE DDL it immediately ran inherited busy_timeout = 0.
// This test proves the central opener installs busy_timeout first.

const tempDirs: string[] = [];
const EMPTY_CHANGES: Changes = { changes: 0, lastInsertRowid: 0 };

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cost-log getConn pragma order", () => {
	it("installs busy_timeout before the CREATE TABLE DDL and preserves the original no-WAL pragma set", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemopi-cost-pragma-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "cost_log.db");

		const statements: string[] = [];
		vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql: string): Changes {
			statements.push(sql);
			return EMPTY_CHANGES;
		});
		vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string): Changes {
			statements.push(sql);
			return EMPTY_CHANGES;
		});

		initCostLog(dbPath);

		// busy_timeout is the very first statement issued on the handle.
		expect(statements[0]).toBe("PRAGMA busy_timeout = 5000");
		// The original opener set NO pragmas; the migration only adds the busy
		// handler, so no journal_mode statement is issued (no WAL sidecars).
		expect(statements.some(s => /journal_mode/i.test(s))).toBe(false);
		// The first lock-taking statement (CREATE TABLE) comes after busy_timeout.
		const firstDdl = statements.findIndex(s => /CREATE TABLE/i.test(s));
		expect(firstDdl).toBeGreaterThan(0);
	});
});
