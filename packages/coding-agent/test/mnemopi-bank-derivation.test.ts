import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	computeMnemopiBankScope,
	extendRecallWithLegacyBanks,
	resetLegacyBankCorruptLatchForTests,
} from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { logger, removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { sqliteRepairGuidance } from "@oh-my-pi/pi-utils/sqlite";

// Set up a fixture filesystem we can reuse across the two regression
// suites — same shape as `~/.omp/memories/mnemopi/` on a real install.
let rootDir: TempDir;
let dbDir: string;
let banksDir: string;
let mainDbPath: string;

beforeAll(async () => {
	rootDir = await TempDir.create("@mnemopi-bank-derivation-");
	dbDir = rootDir.join("mnemopi");
	banksDir = path.join(dbDir, "banks");
	await fs.mkdir(banksDir, { recursive: true });
	mainDbPath = path.join(dbDir, "mnemopi.db");
});

afterAll(async () => {
	await Bun.sleep(0);
	await rootDir.remove();
});

// Schema mirrors the subset of `packages/mnemopi/src/core/beam/schema.ts`
// that this code path needs to probe. We deliberately do not run the
// full schema setup — the cwd-probing query only touches working_memory.
function createBankFixture(bank: string, metadataRows: readonly Record<string, unknown>[]): void {
	const bankDir = path.join(banksDir, bank);
	const dbPath = path.join(bankDir, "mnemopi.db");
	mkdirSync(bankDir, { recursive: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS working_memory (
				id TEXT PRIMARY KEY,
				content TEXT,
				metadata_json TEXT
			)
		`);
		const insert = db.prepare("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)");
		for (const [index, meta] of metadataRows.entries()) {
			insert.run(`row-${bank}-${index}`, "content", JSON.stringify(meta));
		}
	} finally {
		db.close();
	}
}

describe("computeMnemopiBankScope (#2412)", () => {
	// Regression: same cwd must hash to the same bank no matter what the
	// ambient git layout looks like. The previous derivation walked
	// `git.repo.resolveSync(cwd)?.repoRoot ?? path.resolve(cwd)`, so a
	// disappearing/appearing ancestor `.git` repointed the same conversation
	// directory to a different bank and stranded its memories.
	it("returns the same per-project bank for one cwd regardless of git state", async () => {
		const baseDir = await TempDir.create("@mnemopi-stable-bank-");
		try {
			const project = baseDir.join("projects", "omp-workstation");
			await fs.mkdir(project, { recursive: true });
			const withoutGit = computeMnemopiBankScope(undefined, project, "per-project").bank;

			// Plant an ancestor `.git` marker — the old code path resolved
			// `project` to `baseDir/projects` via this file, producing a
			// `projects-<hash>` bank id distinct from the cwd-derived one.
			await fs.mkdir(baseDir.join("projects"), { recursive: true });
			await fs.writeFile(baseDir.join("projects", ".git"), "gitdir: /dev/null\n");
			const withAncestorGit = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(withAncestorGit).toBe(withoutGit);

			await removeWithRetries(baseDir.join("projects", ".git"));
			const afterGitRemoved = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(afterGitRemoved).toBe(withoutGit);
		} finally {
			await Bun.sleep(0);
			await baseDir.remove();
		}
	});

	it("derives different banks for different cwds (sanity)", () => {
		const a = computeMnemopiBankScope(undefined, "/projects/repo-a", "per-project").bank;
		const b = computeMnemopiBankScope(undefined, "/projects/repo-b", "per-project").bank;
		expect(a).not.toBe(b);
	});

	it("per-project-tagged opens both the project bank and the shared default", () => {
		const scope = computeMnemopiBankScope(undefined, "/projects/repo", "per-project-tagged");
		expect(scope.retainBank).toBe(scope.bank);
		expect(scope.recallBanks).toContain(scope.bank);
		expect(scope.recallBanks).toContain("default");
	});

	it("global ignores the cwd entirely", () => {
		const here = computeMnemopiBankScope(undefined, "/projects/here", "global");
		const there = computeMnemopiBankScope(undefined, "/elsewhere", "global");
		expect(here).toEqual(there);
		expect(here.bank).toBe("default");
	});
});

describe("extendRecallWithLegacyBanks (#2412)", () => {
	it("adds a sibling bank only when all working_memory rows tag the active cwd", () => {
		const activeCwd = path.join(rootDir.path(), "projects", "myrepo");
		createBankFixture("legacy-A", [{ session_id: "old", cwd: activeCwd }]);
		createBankFixture("unrelated-B", [{ session_id: "other", cwd: path.join(rootDir.path(), "other", "place") }]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, activeCwd);
		expect(extended).toContain("active-bank");
		expect(extended).toContain("legacy-A");
		expect(extended).not.toContain("unrelated-B");
	});

	it("skips mixed-cwd legacy banks because recall cannot filter rows by cwd", () => {
		const childCwd = path.join(rootDir.path(), "projects", "safe-child");
		createBankFixture("mixed-cwd-legacy", [
			{ cwd: childCwd },
			{ cwd: path.join(rootDir.path(), "projects", "sibling-child") },
		]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, childCwd);
		expect(extended).not.toContain("mixed-cwd-legacy");
	});
});

describe("extendRecallWithLegacyBanks edge cases", () => {
	it("ignores banks already in the recall set", () => {
		const cwd = path.join(rootDir.path(), "projects", "already-in-set");
		createBankFixture("already-in-set", [{ cwd }]);
		const extended = extendRecallWithLegacyBanks(["already-in-set"], mainDbPath, cwd);
		expect(extended).toEqual(["already-in-set"]);
	});

	it("returns the input unchanged when banks/ does not exist", () => {
		const missingRoot = rootDir.join("no-such-mnemopi", "mnemopi.db");
		const out = extendRecallWithLegacyBanks(["one"], missingRoot, "/home/user/anywhere");
		expect(out).toEqual(["one"]);
	});

	it("tolerates a corrupt bank database without throwing", async () => {
		const corruptDir = path.join(banksDir, "corrupt-C");
		await fs.mkdir(corruptDir, { recursive: true });
		await fs.writeFile(path.join(corruptDir, "mnemopi.db"), "not a sqlite file");
		const out = extendRecallWithLegacyBanks(["active"], mainDbPath, path.join(rootDir.path(), "some", "cwd"));
		expect(out).toContain("active");
		expect(out).not.toContain("corrupt-C");
	});

	it("bounds the total scan time when legacy banks are exclusively locked", () => {
		const lockedBanks: Database[] = [];
		const suffix = crypto.randomUUID();
		try {
			for (let index = 0; index < 3; index++) {
				const bank = `aaa-locked-${suffix}-${index}`;
				createBankFixture(bank, [{ cwd: path.join(rootDir.path(), "projects", "locked") }]);
				const db = new Database(path.join(banksDir, bank, "mnemopi.db"));
				db.exec("BEGIN EXCLUSIVE");
				lockedBanks.push(db);
			}

			const started = performance.now();
			const extended = extendRecallWithLegacyBanks(
				["active"],
				mainDbPath,
				path.join(rootDir.path(), "projects", "locked"),
			);
			const elapsedMs = performance.now() - started;

			expect(extended).toEqual(["active"]);
			expect(elapsedMs).toBeLessThan(5000);
		} finally {
			for (const db of lockedBanks) {
				db.exec("ROLLBACK");
				db.close();
			}
		}
	});
});

describe("bankOnlyHasCwd corrupt-store latch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetLegacyBankCorruptLatchForTests();
	});

	it("latches after one corrupt probe and stops re-opening the damaged bank", async () => {
		const corruptDir = path.join(banksDir, "corrupt-latch-D");
		await fs.mkdir(corruptDir, { recursive: true });
		const corruptDbPath = path.join(corruptDir, "mnemopi.db");
		await fs.writeFile(corruptDbPath, "not a sqlite file");

		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const cwd = path.join(rootDir.path(), "projects", "latch-test");

		// First call probes the corrupt bank, throws SQLITE_NOTADB, and latches.
		const out1 = extendRecallWithLegacyBanks(["active"], mainDbPath, cwd);
		expect(out1).toContain("active");
		expect(out1).not.toContain("corrupt-latch-D");

		// Second call short-circuits before touching the damaged file.
		const out2 = extendRecallWithLegacyBanks(["active"], mainDbPath, cwd);
		expect(out2).toContain("active");
		expect(out2).not.toContain("corrupt-latch-D");

		const damagedErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("legacy bank database is damaged"),
		);
		expect(damagedErrors).toHaveLength(1);
		expect(String(damagedErrors[0]?.[0])).toContain(corruptDbPath);
		expect(String(damagedErrors[0]?.[0])).toContain(sqliteRepairGuidance(corruptDbPath));

		// Non-corrupt errors still use debug, not error.
		const legacyDebugs = debugSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0] === "Mnemopi: legacy bank probe failed",
		);
		expect(legacyDebugs).toHaveLength(0);
	});
});
