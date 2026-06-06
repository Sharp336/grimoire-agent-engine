import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage } from "../src/session/agent-storage";
import { readTableSql } from "./helpers/sqlite-inspect";

const HALF_LIFE_DAYS = 21;
const HALF_LIFE_MS = HALF_LIFE_DAYS * 86_400 * 1000;
const THROTTLE_SECS = 300;

describe("AgentStorage skill_usage tracking", () => {
	let tempDir = "";

	afterEach(async () => {
		// Reset fake time after each test
		setSystemTime();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("round-trip: record once, getSkillUsage returns the skill with score ≈ 1.0", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-roundtrip-"));
		const dbPath = path.join(tempDir, "agent.db");

		const baseTime = new Date("2026-01-01T00:00:00Z");
		setSystemTime(baseTime);

		const storage = await AgentStorage.open(dbPath);

		storage.recordSkillUsage("bash");

		// Pin time to same moment to avoid decay (dt = 0 → score = 1.0)
		setSystemTime(baseTime);

		const usage = storage.getSkillUsage();
		expect(usage).toHaveLength(1);
		expect(usage[0].name).toBe("bash");
		expect(usage[0].score).toBeCloseTo(1.0, 5);
		expect(usage[0].totalCount).toBe(1);
	});

	it("throttle: second call within 300s is skipped, total_count stays at 1", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-throttle-"));
		const dbPath = path.join(tempDir, "agent.db");

		const baseTime = new Date("2026-01-01T00:00:00Z");
		setSystemTime(baseTime);

		const storage = await AgentStorage.open(dbPath);
		storage.recordSkillUsage("read_file");

		// Advance by 299 seconds — still within throttle window
		setSystemTime(new Date(baseTime.getTime() + 299_000));
		storage.recordSkillUsage("read_file");

		const usage = storage.getSkillUsage();
		expect(usage).toHaveLength(1);
		expect(usage[0].totalCount).toBe(1);
	});

	it("no-throttle: record past 300s window increments total_count to 2", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-nothrottle-"));
		const dbPath = path.join(tempDir, "agent.db");

		const baseTime = new Date("2026-01-01T00:00:00Z");
		setSystemTime(baseTime);

		const storage = await AgentStorage.open(dbPath);
		storage.recordSkillUsage("write_file");

		// Advance by 301 seconds — past the throttle window
		setSystemTime(new Date(baseTime.getTime() + 301_000));
		storage.recordSkillUsage("write_file");

		const usage = storage.getSkillUsage();
		expect(usage).toHaveLength(1);
		expect(usage[0].totalCount).toBe(2);
	});

	it("total_count increments correctly across multiple allowed recordings", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-count-"));
		const dbPath = path.join(tempDir, "agent.db");

		const baseTime = new Date("2026-01-01T00:00:00Z");
		setSystemTime(baseTime);

		const storage = await AgentStorage.open(dbPath);

		for (let i = 0; i < 5; i++) {
			setSystemTime(new Date(baseTime.getTime() + i * 301_000));
			storage.recordSkillUsage("grep");
		}

		const usage = storage.getSkillUsage();
		expect(usage[0].name).toBe("grep");
		expect(usage[0].totalCount).toBe(5);
	});

	it("v5→v6 migration: open a v5 DB, migrates cleanly and skill_usage table exists", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-migrate-"));
		const dbPath = path.join(tempDir, "agent.db");

		// Seed a v5 database (no skill_usage table)
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (5);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		legacyDb.close();

		const storage = await AgentStorage.open(dbPath);

		// skill_usage table should now exist
		const tableSql = readTableSql(dbPath, "skill_usage");
		expect(tableSql).not.toBeNull();
		expect(tableSql).toContain("skill_name");
		expect(tableSql).toContain("decayed_count");

		// Should be able to record and retrieve skill usage on migrated DB
		storage.recordSkillUsage("ls");
		const usage = storage.getSkillUsage();
		expect(usage).toHaveLength(1);
		expect(usage[0].name).toBe("ls");
	});

	it("decay math: score after one half-life ≈ 0.5", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-decay-"));
		const dbPath = path.join(tempDir, "agent.db");

		const baseTime = new Date("2026-01-01T00:00:00Z");
		setSystemTime(baseTime);

		const storage = await AgentStorage.open(dbPath);
		storage.recordSkillUsage("edit_file");

		// Advance by exactly one half-life
		setSystemTime(new Date(baseTime.getTime() + HALF_LIFE_MS));

		const usage = storage.getSkillUsage();
		expect(usage).toHaveLength(1);
		// After one half-life, initial score of 1 decays to 0.5
		expect(usage[0].score).toBeCloseTo(0.5, 4);
	});

	it("throttle boundary: dt=300s exactly is NOT throttled (strict < 300)", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-boundary-"));
		const dbPath = path.join(tempDir, "agent.db");

		const baseTime = new Date("2026-01-01T00:00:00Z");
		setSystemTime(baseTime);

		const storage = await AgentStorage.open(dbPath);
		storage.recordSkillUsage("read_file");

		// Advance by exactly 300s — condition is `< 300`, so dt=300 is NOT throttled
		setSystemTime(new Date(baseTime.getTime() + 300_000));
		storage.recordSkillUsage("read_file");

		const usage = storage.getSkillUsage();
		expect(usage).toHaveLength(1);
		expect(usage[0].totalCount).toBe(2);
	});
});
