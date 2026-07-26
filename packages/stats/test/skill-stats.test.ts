import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSkillDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getFileOffset, getSkillStats, getSkillStatsByModel, initDb } from "@oh-my-pi/omp-stats/db";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import type { SkillDashboardStats, SkillUsageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-skill-stats-");

const FOLDER_SLUG = "--tmp--skill-stats";
const MODEL = "gpt-5.4";
const PROVIDER = "openai";
const TS1 = "2026-06-24T10:00:00.000Z";
const TS2 = "2026-06-24T10:05:00.000Z";
const TS3 = "2026-06-24T10:10:00.000Z";

interface ToolCallFixture {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface AssistantFixture {
	id: string;
	timestamp: string;
	calls: ToolCallFixture[];
	totalTokens: number;
	outputTokens: number;
	cost: number;
}

function assistantEntry(opts: AssistantFixture) {
	return {
		type: "message",
		id: opts.id,
		timestamp: opts.timestamp,
		message: {
			role: "assistant",
			content: opts.calls.map(call => ({
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: call.arguments,
			})),
			api: "openai-responses",
			provider: PROVIDER,
			model: MODEL,
			usage: {
				input: 10,
				output: opts.outputTokens,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: opts.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost },
			},
			stopReason: "toolUse",
			timestamp: Date.parse(opts.timestamp),
		},
	};
}

async function writeSessionFile(fileName: string, id: string, entries: unknown[]): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), FOLDER_SLUG);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: "/tmp/project",
	};
	const lines = [header, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

function skillRow(rows: SkillUsageStats[], skill = "review"): SkillUsageStats {
	const row = rows.find(candidate => candidate.skill === skill);
	if (!row) throw new Error(`missing aggregate row for skill ${skill}`);
	return row;
}

describe("skill usage stats pipeline", () => {
	it("extracts canonical skills, preserves additive attribution, and serves the API", async () => {
		await writeSessionFile("session.jsonl", "skill-sess", [
			assistantEntry({
				id: "asst-1",
				timestamp: TS1,
				calls: [
					{ id: "call-1", name: "read", arguments: { path: "skill://review" } },
					{ id: "call-2", name: "bash", arguments: { command: "echo skill://review" } },
				],
				totalTokens: 100,
				outputTokens: 20,
				cost: 0.01,
			}),
			assistantEntry({
				id: "asst-2",
				timestamp: TS2,
				calls: [{ id: "call-3", name: "read", arguments: { path: "skill://review/checklist.md:raw:1-10" } }],
				totalTokens: 40,
				outputTokens: 8,
				cost: 0.004,
			}),
			assistantEntry({
				id: "asst-3",
				timestamp: TS3,
				calls: [
					{ id: "call-4", name: "read", arguments: { path: "/tmp/readme.md" } },
					{ id: "call-5", name: "bash", arguments: { command: "echo skill://review" } },
				],
				totalTokens: 20,
				outputTokens: 4,
				cost: 0.002,
			}),
		]);

		await syncAllSessions({ workers: 1 });

		const stats = getSkillStats();
		expect(stats).toHaveLength(1);
		const review = skillRow(stats);
		expect(review.calls).toBe(2);
		expect(review.costShare).toBeCloseTo(0.009, 8);

		const byModel = getSkillStatsByModel();
		expect(byModel).toHaveLength(1);
		expect(byModel[0]).toMatchObject({ skill: "review", model: MODEL, provider: PROVIDER, calls: 2 });
		expect(byModel[0]?.costShare).toBeCloseTo(0.009, 8);

		const dashboard = await getSkillDashboardStats("all");
		expect(dashboard.bySkill).toEqual(stats);
		expect(dashboard.bySkillModel).toEqual(byModel);
		expect(dashboard.bySkill).toHaveLength(1);
		expect(dashboard.bySkill[0]?.skill).toBe("review");
		expect(dashboard.series.reduce((total, point) => total + point.calls, 0)).toBe(2);
		expect(dashboard.series.every(point => point.skill === "review")).toBe(true);

		const response = await handleApi(new Request("http://localhost/api/stats/skills?range=all"));
		expect(response.status).toBe(200);
		expect((await response.json()) as SkillDashboardStats).toEqual(dashboard);
	});
	it("normalizes canonical skill URL selectors before persistence", async () => {
		const selectorPaths = [
			"skill://review:raw",
			"skill://review:1-10",
			"skill://review:raw:1-10",
			"skill://review:conflicts",
			"skill://review:5-16,960-973",
			"SKILL://review:raw",
			"sKiLl://review/checklist.md:raw:1-10",
		];
		await writeSessionFile("selector-grammar.jsonl", "selector-grammar-sess", [
			assistantEntry({
				id: "selector-grammar-asst",
				timestamp: TS1,
				calls: selectorPaths.map((path, index) => ({
					id: `selector-call-${index}`,
					name: "read",
					arguments: { path },
				})),
				totalTokens: 100,
				outputTokens: 20,
				cost: 0.01,
			}),
		]);

		await syncAllSessions({ workers: 1 });

		const stats = getSkillStats();
		expect(stats).toHaveLength(1);
		expect(stats[0]).toMatchObject({ skill: "review", calls: selectorPaths.length });
	});

	it("migrates a legacy tool_calls table and replays historical skill invocations", async () => {
		const sessionFile = await writeSessionFile("migration.jsonl", "migration-sess", [
			assistantEntry({
				id: "migration-asst",
				timestamp: TS1,
				calls: [{ id: "migration-call", name: "read", arguments: { path: "skill://legacy" } }],
				totalTokens: 10,
				outputTokens: 2,
				cost: 0.001,
			}),
		]);

		await initDb();
		closeDb();
		const legacy = new Database(getStatsDbPath());
		legacy.run("DROP TABLE tool_calls");
		legacy.run(`
			CREATE TABLE tool_calls (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				tool_call_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				model TEXT NOT NULL,
				provider TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				agent_type TEXT NOT NULL DEFAULT 'main',
				calls_in_turn INTEGER NOT NULL DEFAULT 1,
				args_chars INTEGER NOT NULL DEFAULT 0,
				result_chars INTEGER,
				is_error INTEGER,
				UNIQUE(session_file, tool_call_id)
			);
		`);
		legacy.run("DELETE FROM meta WHERE key IN ('tool_calls_v1', 'tool_calls_v2')");
		legacy.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("tool_calls_v1", "complete");
		const fileStats = await fs.stat(sessionFile);
		legacy
			.prepare("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)")
			.run(sessionFile, fileStats.size, fileStats.mtimeMs);
		legacy.close();

		await initDb();
		const migrated = new Database(getStatsDbPath(), { readonly: true });
		const columns = migrated.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ name: string }>;
		expect(columns.some(column => column.name === "skill_name")).toBe(true);
		migrated.close();
		expect(getFileOffset(sessionFile)).toBeNull();

		await syncAllSessions({ workers: 1 });
		expect(skillRow(getSkillStats(), "legacy").calls).toBe(1);
	});
});
