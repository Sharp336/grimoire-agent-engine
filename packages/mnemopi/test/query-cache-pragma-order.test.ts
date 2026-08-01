import { type Changes, Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryCache } from "@oh-my-pi/pi-mnemopi/core/query-cache";

// Contract (issue #2421): the busy handler must be installed BEFORE any
// lock-taking statement. #initDb previously ran `PRAGMA journal_mode=WAL`
// with no busy_timeout at all, so a concurrent WAL checkpoint could surface
// as a silent miss. This test proves the central opener fixes the ordering.

const tempDirs: string[] = [];
const EMPTY_CHANGES: Changes = { changes: 0, lastInsertRowid: 0 };

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("QueryCache #initDb pragma order", () => {
	it("installs busy_timeout before the first lock-taking statement and enables WAL", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemopi-qc-pragma-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "query_cache.db");

		// Record every SQL statement issued on any Database handle, in order,
		// without executing them. The first entry is therefore the first
		// statement the opener issues on the new connection.
		const statements: string[] = [];
		vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql: string): Changes {
			statements.push(sql);
			return EMPTY_CHANGES;
		});
		vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string): Changes {
			statements.push(sql);
			return EMPTY_CHANGES;
		});

		const cache = new QueryCache({ dbPath, maxSize: 10 });
		cache.close();

		// busy_timeout is the very first statement issued on the handle.
		expect(statements[0]).toBe("PRAGMA busy_timeout = 5000");
		// WAL is set for a file-backed cache.
		const walIndex = statements.findIndex(s => /journal_mode/i.test(s));
		expect(walIndex).toBeGreaterThan(0);
		expect(statements[walIndex]).toContain("WAL");
		// The first lock-taking statement (schema DDL) comes after busy_timeout.
		const firstDdl = statements.findIndex(s => /CREATE (TABLE|INDEX)/i.test(s));
		expect(firstDdl).toBeGreaterThan(0);
		expect(firstDdl).toBeGreaterThan(walIndex);
	});
});
