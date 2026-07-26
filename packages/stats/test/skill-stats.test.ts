import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSkillDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import {
	closeDb,
	getFileOffset,
	getSkillStats,
	getSkillStatsByModel,
	getSkillTimeSeries,
	initDb,
} from "@oh-my-pi/omp-stats/db";
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

function toolResultEntry(
	id: string,
	toolCallId: string,
	skillTargets: Array<{ skill: string; target: string }>,
	isError = false,
) {
	return {
		type: "message",
		id,
		timestamp: TS1,
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			details: { skillTargets },
			isError,
			timestamp: Date.parse(TS1),
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

	it("splits multi-target reads additively across skills and API series", async () => {
		const readArguments = { path: "README.md;skill://alpha;skill://beta" };
		await writeSessionFile("multi-target.jsonl", "multi-target-sess", [
			assistantEntry({
				id: "multi-asst",
				timestamp: TS1,
				calls: [
					{ id: "multi-read", name: "read", arguments: readArguments },
					{ id: "multi-bash", name: "bash", arguments: { command: "echo ok" } },
				],
				totalTokens: 120,
				outputTokens: 30,
				cost: 0.012,
			}),
			toolResultEntry("multi-read-result", "multi-read", [
				{ skill: "alpha", target: "alpha.md" },
				{ skill: "beta", target: "beta.md" },
			]),
		]);

		await syncAllSessions({ workers: 1 });

		const readArgsShare = JSON.stringify(readArguments).length / 2;
		const readResultShare = "result".length / 2;
		const stats = getSkillStats();
		expect(stats).toHaveLength(2);
		for (const skill of ["alpha", "beta"]) {
			expect(skillRow(stats, skill)).toMatchObject({
				calls: 1,
				totalTokensShare: 30,
				outputTokensShare: 7.5,
				costShare: 0.003,
				argsChars: readArgsShare,
				resultChars: readResultShare,
			});
		}
		const skillTotals = stats.reduce(
			(total, row) => ({
				totalTokens: total.totalTokens + row.totalTokensShare,
				outputTokens: total.outputTokens + row.outputTokensShare,
				cost: total.cost + row.costShare,
				args: total.args + row.argsChars,
				result: total.result + row.resultChars,
			}),
			{ totalTokens: 0, outputTokens: 0, cost: 0, args: 0, result: 0 },
		);
		expect(skillTotals).toEqual({
			totalTokens: 60,
			outputTokens: 15,
			cost: 0.006,
			args: JSON.stringify(readArguments).length,
			result: "result".length,
		});

		const byModel = getSkillStatsByModel();
		expect(byModel).toHaveLength(2);
		expect(byModel.every(row => row.model === MODEL && row.provider === PROVIDER)).toBe(true);
		expect(byModel.reduce((sum, row) => sum + row.totalTokensShare, 0)).toBe(60);
		const series = getSkillTimeSeries(14, null);
		expect(series.reduce((sum, point) => sum + point.calls, 0)).toBe(2);
		expect(series.every(point => point.calls === 1 && point.errors === 0)).toBe(true);

		const apiResponse = await handleApi(new Request("http://localhost/api/stats/skills?range=all"));
		expect(apiResponse.status).toBe(200);
		const dashboard = (await apiResponse.json()) as SkillDashboardStats;
		expect(dashboard.bySkill).toEqual(stats);
		expect(dashboard.bySkillModel).toEqual(byModel);
		expect(dashboard.series).toEqual(series);
	});

	it("counts duplicate executed targets while splitting parent shares", async () => {
		await writeSessionFile("duplicate-target.jsonl", "duplicate-target-sess", [
			assistantEntry({
				id: "duplicate-asst",
				timestamp: TS1,
				calls: [{ id: "duplicate-call", name: "read", arguments: { path: "skill://alpha" } }],
				totalTokens: 60,
				outputTokens: 12,
				cost: 0.006,
			}),
			toolResultEntry(
				"duplicate-result",
				"duplicate-call",
				[
					{ skill: "alpha", target: "one.md" },
					{ skill: "alpha", target: "two.md" },
				],
				true,
			),
		]);

		await syncAllSessions({ workers: 1 });

		const alpha = skillRow(getSkillStats(), "alpha");
		expect(alpha).toMatchObject({
			calls: 2,
			errors: 2,
			totalTokensShare: 60,
			outputTokensShare: 12,
			costShare: 0.006,
		});
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

	it("replaces provisional assistant attribution with a late result and stays idempotent", async () => {
		const sessionFile = await writeSessionFile("late-result.jsonl", "late-result-sess", [
			assistantEntry({
				id: "late-asst",
				timestamp: TS1,
				calls: [{ id: "late-call", name: "read", arguments: { path: "skill://provisional" } }],
				totalTokens: 20,
				outputTokens: 4,
				cost: 0.002,
			}),
		]);

		await syncAllSessions({ workers: 1 });
		expect(skillRow(getSkillStats(), "provisional").calls).toBe(1);

		await fs.appendFile(
			sessionFile,
			`${JSON.stringify(toolResultEntry("late-result", "late-call", [{ skill: "authoritative", target: "done.md" }]))}\n`,
		);
		await syncAllSessions({ workers: 1 });
		expect(getSkillStats().find(row => row.skill === "provisional")).toBeUndefined();
		expect(skillRow(getSkillStats(), "authoritative").calls).toBe(1);

		const afterResult = getSkillStats();
		await syncAllSessions({ workers: 1 });
		expect(getSkillStats()).toEqual(afterResult);
	});

	it("does not create a child invocation for a fork-skipped result", async () => {
		await writeSessionFile("01-fork-parent.jsonl", "fork-parent-sess", [
			assistantEntry({
				id: "fork-asst",
				timestamp: TS1,
				calls: [{ id: "fork-call", name: "read", arguments: { path: "skill://parent" } }],
				totalTokens: 20,
				outputTokens: 4,
				cost: 0.002,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		await writeSessionFile("02-fork-child.jsonl", "fork-child-sess", [
			assistantEntry({
				id: "fork-asst",
				timestamp: TS1,
				calls: [{ id: "fork-call", name: "read", arguments: { path: "skill://parent" } }],
				totalTokens: 20,
				outputTokens: 4,
				cost: 0.002,
			}),
			toolResultEntry("fork-result", "fork-call", [{ skill: "child", target: "child.md" }]),
		]);

		await syncAllSessions({ workers: 1 });
		expect(skillRow(getSkillStats(), "parent").calls).toBe(1);
		expect(getSkillStats().find(row => row.skill === "child")).toBeUndefined();
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
			toolResultEntry("migration-result", "migration-call", [{ skill: "legacy", target: "README.md" }]),
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
				skill_name TEXT,
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
		const legacyInsert = legacy.prepare(`
			INSERT INTO tool_calls (
				session_file, entry_id, tool_call_id, folder, tool_name, skill_name,
				model, provider, timestamp, calls_in_turn, args_chars, result_chars, is_error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const legacyValues = [MODEL, PROVIDER, Date.parse(TS1), 1, 10, null, 0];
		legacyInsert.run(sessionFile, "migration-asst", "migration-call", FOLDER_SLUG, "read", "legacy", ...legacyValues);
		legacyInsert.run(
			"/tmp/unavailable.jsonl",
			"unavailable-entry",
			"unavailable-call",
			FOLDER_SLUG,
			"read",
			"unavailable",
			...legacyValues,
		);
		legacyInsert.run("/tmp/null.jsonl", "null-entry", "null-call", FOLDER_SLUG, "read", null, ...legacyValues);
		legacy.run("DELETE FROM meta WHERE key IN ('tool_calls_v1', 'tool_calls_v2', 'skill_invocations_v1')");
		legacy.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("tool_calls_v1", "complete");
		const fileStats = await fs.stat(sessionFile);
		legacy
			.prepare("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)")
			.run(sessionFile, fileStats.size, fileStats.mtimeMs);
		legacy.close();

		await initDb();
		const migrated = new Database(getStatsDbPath(), { readonly: true });
		const columns = migrated.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ name: string }>;
		const migratedToolCalls = migrated
			.prepare("SELECT tool_call_id, skill_name FROM tool_calls ORDER BY tool_call_id")
			.all() as Array<{ tool_call_id: string; skill_name: string | null }>;
		expect(migratedToolCalls).toEqual([
			{ tool_call_id: "migration-call", skill_name: "legacy" },
			{ tool_call_id: "null-call", skill_name: null },
			{ tool_call_id: "unavailable-call", skill_name: "unavailable" },
		]);
		expect(columns.some(column => column.name === "skill_name")).toBe(true);
		const invocationColumns = migrated.prepare("PRAGMA table_info(skill_invocations)").all() as Array<{
			name: string;
		}>;
		expect(invocationColumns.map(column => column.name)).toEqual([
			"id",
			"session_file",
			"tool_call_id",
			"target_index",
			"target",
			"skill_name",
		]);
		const seeded = migrated
			.prepare("SELECT skill_name, target FROM skill_invocations ORDER BY skill_name")
			.all() as Array<{ skill_name: string; target: string | null }>;
		expect(seeded).toEqual([
			{ skill_name: "legacy", target: null },
			{ skill_name: "unavailable", target: null },
		]);
		migrated.close();
		expect(getFileOffset(sessionFile)).toBeNull();

		await syncAllSessions({ workers: 1 });
		const afterSync = new Database(getStatsDbPath(), { readonly: true });
		const retainedToolCalls = afterSync
			.prepare("SELECT tool_call_id, skill_name FROM tool_calls ORDER BY tool_call_id")
			.all() as Array<{ tool_call_id: string; skill_name: string | null }>;
		expect(retainedToolCalls).toEqual(migratedToolCalls);
		const children = afterSync
			.prepare("SELECT tool_call_id, skill_name, target FROM skill_invocations ORDER BY tool_call_id, target_index")
			.all() as Array<{ tool_call_id: string; skill_name: string; target: string | null }>;
		expect(children).toEqual([
			{ tool_call_id: "migration-call", skill_name: "legacy", target: "README.md" },
			{ tool_call_id: "unavailable-call", skill_name: "unavailable", target: null },
		]);
		const sentinels = afterSync
			.prepare("SELECT key, value FROM meta WHERE key IN ('tool_calls_v2', 'skill_invocations_v1') ORDER BY key")
			.all() as Array<{ key: string; value: string }>;
		expect(sentinels).toEqual([
			{ key: "skill_invocations_v1", value: "complete" },
			{ key: "tool_calls_v2", value: "complete" },
		]);
		afterSync.close();
		expect(skillRow(getSkillStats(), "legacy").calls).toBe(1);
		expect(skillRow(getSkillStats(), "unavailable").calls).toBe(1);
		expect(getSkillStats().find(row => row.skill === "null")).toBeUndefined();
		expect(getFileOffset(sessionFile)).not.toBeNull();

		await syncAllSessions({ workers: 1 });
		const afterResync = new Database(getStatsDbPath(), { readonly: true });
		const childrenAfterResync = afterResync
			.prepare("SELECT tool_call_id, skill_name, target FROM skill_invocations ORDER BY tool_call_id, target_index")
			.all() as Array<{ tool_call_id: string; skill_name: string; target: string | null }>;
		expect(childrenAfterResync).toEqual(children);
		afterResync.close();
	});
});
