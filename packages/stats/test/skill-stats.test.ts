import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSkillDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import {
	getFileOffset,
	getSkillStats,
	getSkillStatsByModel,
	getSkillTimeSeries,
	initDb,
	insertProvisionalSkillInvocations,
	insertToolCalls,
	upsertResultSkillInvocations,
} from "@oh-my-pi/omp-stats/db";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import type { SkillDashboardStats, SkillUsageStats, ToolCallStats } from "@oh-my-pi/omp-stats/types";
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

interface SkillTargetFixture {
	skill: string;
	target: string;
	isError?: boolean;
}

function toolResultEntry(id: string, toolCallId: string, skillTargets: SkillTargetFixture[], isError = false) {
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

async function writeSessionFile(
	fileName: string,
	id: string,
	entries: unknown[],
	parentSession?: string,
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), FOLDER_SLUG);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: "/tmp/project",
		...(parentSession ? { parentSession } : {}),
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

function toolCallFixture(
	sessionFile: string,
	entryId: string,
	toolCallId: string,
	skillName = "review",
): ToolCallStats {
	return {
		sessionFile,
		entryId,
		toolCallId,
		folder: FOLDER_SLUG,
		toolName: "read",
		skillName,
		model: MODEL,
		provider: PROVIDER,
		timestamp: Date.parse(TS1),
		agentType: "main",
		callsInTurn: 1,
		argsChars: 10,
	};
}

async function createForkFiles(): Promise<{ parentFile: string; childFile: string }> {
	const parentEntries = [
		assistantEntry({
			id: "fork-asst",
			timestamp: TS1,
			calls: [{ id: "fork-call", name: "read", arguments: { path: "skill://parent" } }],
			totalTokens: 20,
			outputTokens: 4,
			cost: 0.002,
		}),
		toolResultEntry("parent-result", "fork-call", [{ skill: "parent", target: "parent.md" }]),
	];
	const parentFile = await writeSessionFile("99_parent.jsonl", "fork-parent-sess", parentEntries);
	const childFile = await writeSessionFile(
		"01_child.jsonl",
		"fork-child-sess",
		[
			assistantEntry({
				id: "fork-asst",
				timestamp: TS1,
				calls: [{ id: "fork-call", name: "read", arguments: { path: "skill://parent" } }],
				totalTokens: 20,
				outputTokens: 4,
				cost: 0.002,
			}),
			toolResultEntry("child-result", "fork-call", [{ skill: "child", target: "child.md" }]),
		],
		"fork-parent-sess",
	);
	return { parentFile, childFile };
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

	it("keeps partial skill read failures attributable to their targets", async () => {
		await writeSessionFile("partial-failure.jsonl", "partial-failure-sess", [
			assistantEntry({
				id: "partial-asst",
				timestamp: TS1,
				calls: [{ id: "partial-read", name: "read", arguments: { path: "skill://available;skill://missing" } }],
				totalTokens: 60,
				outputTokens: 12,
				cost: 0.006,
			}),
			toolResultEntry("partial-result", "partial-read", [
				{ skill: "available", target: "skill://available" },
				{ skill: "missing", target: "skill://missing", isError: true },
			]),
		]);

		await syncAllSessions({ workers: 1 });

		expect(skillRow(getSkillStats(), "available")).toMatchObject({ calls: 1, errors: 0 });
		expect(skillRow(getSkillStats(), "missing")).toMatchObject({ calls: 1, errors: 1 });
		const errorsBySkill = new Map(getSkillTimeSeries(14, null).map(point => [point.skill, point.errors]));
		expect(errorsBySkill).toEqual(
			new Map([
				["available", 0],
				["missing", 1],
			]),
		);
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
	it("does not infer a delayed legacy delimited read", async () => {
		const sessionFile = await writeSessionFile("late-legacy-result.jsonl", "late-legacy-result-sess", [
			assistantEntry({
				id: "late-legacy-asst",
				timestamp: TS1,
				calls: [{ id: "late-legacy-call", name: "read", arguments: { path: "README.md;skill://legacy" } }],
				totalTokens: 20,
				outputTokens: 4,
				cost: 0.002,
			}),
		]);

		await syncAllSessions({ workers: 1 });
		expect(getSkillStats().find(row => row.skill === "legacy")).toBeUndefined();

		await fs.appendFile(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				id: "late-legacy-result",
				timestamp: TS1,
				message: {
					role: "toolResult",
					toolCallId: "late-legacy-call",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					timestamp: Date.parse(TS1),
				},
			})}\n`,
		);
		await syncAllSessions({ workers: 1 });
		expect(getSkillStats().find(row => row.skill === "legacy")).toBeUndefined();

		const afterResult = getSkillStats();
		await syncAllSessions({ workers: 1 });
		expect(getSkillStats()).toEqual(afterResult);
	});

	it("does not downgrade an executed target after a stale provisional write", async () => {
		await initDb();
		const call = toolCallFixture("/tmp/skill-target.jsonl", "target-entry", "target-call", "inferred");
		insertToolCalls([call]);
		upsertResultSkillInvocations([
			{
				sessionFile: call.sessionFile,
				toolCallId: call.toolCallId,
				targetIndex: 0,
				skillName: "executed",
				target: "executed.md",
			},
		]);
		insertProvisionalSkillInvocations([
			{
				sessionFile: call.sessionFile,
				toolCallId: call.toolCallId,
				targetIndex: 0,
				skillName: "stale",
				target: null,
			},
		]);

		const database = new Database(getStatsDbPath(), { readonly: true });
		const row = database
			.prepare("SELECT skill_name, target FROM skill_invocations WHERE session_file = ? AND tool_call_id = ?")
			.get(call.sessionFile, call.toolCallId) as { skill_name: string; target: string | null };
		database.close();
		expect(row).toEqual({ skill_name: "executed", target: "executed.md" });
	});

	it("uses the first existing owner for copied calls", async () => {
		const { childFile } = await createForkFiles();

		await syncAllSessions({ workers: 1 });
		const database = new Database(getStatsDbPath(), { readonly: true });
		const toolRows = database
			.prepare("SELECT session_file FROM tool_calls WHERE tool_call_id = ?")
			.all("fork-call") as Array<{ session_file: string }>;
		const invocationRows = database
			.prepare("SELECT session_file, skill_name, target FROM skill_invocations WHERE tool_call_id = ?")
			.all("fork-call") as Array<{ session_file: string; skill_name: string; target: string | null }>;
		database.close();
		expect(toolRows).toEqual([{ session_file: childFile }]);
		expect(invocationRows).toEqual([{ session_file: childFile, skill_name: "child", target: "child.md" }]);
	});

	it("retains the first existing historical tool row", async () => {
		await initDb();
		const unavailable = toolCallFixture("/tmp/unavailable.jsonl", "retained-entry", "retained-call", "legacy");
		const current = { ...unavailable, sessionFile: "/tmp/current.jsonl", skillName: "current" };
		insertToolCalls([unavailable]);
		insertToolCalls([current]);

		const database = new Database(getStatsDbPath(), { readonly: true });
		const rows = database
			.prepare("SELECT session_file, skill_name FROM tool_calls WHERE tool_call_id = ?")
			.all(unavailable.toolCallId) as Array<{ session_file: string; skill_name: string | null }>;
		database.close();
		expect(rows).toEqual([{ session_file: unavailable.sessionFile, skill_name: "legacy" }]);
	});
	it("migrates a pre-skills tool_calls_v1 schema without inventing legacy delimited reads", async () => {
		const sessionFile = await writeSessionFile("v1-migration.jsonl", "v1-migration-sess", [
			assistantEntry({
				id: "v1-asst",
				timestamp: TS1,
				calls: [
					{ id: "v1-delimited-call", name: "read", arguments: { path: "README.md;skill://legacy" } },
					{ id: "v1-direct-call", name: "read", arguments: { path: "skill://direct" } },
				],
				totalTokens: 10,
				outputTokens: 2,
				cost: 0.001,
			}),
			{
				type: "message",
				id: "v1-result",
				timestamp: TS1,
				message: {
					role: "toolResult",
					toolCallId: "v1-delimited-call",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					timestamp: Date.parse(TS1),
				},
			},
		]);

		await fs.mkdir(path.dirname(getStatsDbPath()), { recursive: true });
		const legacy = new Database(getStatsDbPath());
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
			CREATE TABLE meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
		legacy.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("tool_calls_v1", "complete");
		const legacyInsert = legacy.prepare(`
			INSERT INTO tool_calls (
				session_file, entry_id, tool_call_id, folder, tool_name,
				model, provider, timestamp, calls_in_turn, args_chars, result_chars, is_error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const legacyValues = [MODEL, PROVIDER, Date.parse(TS1), 2, 10, null, 0];
		legacyInsert.run(sessionFile, "v1-asst", "v1-delimited-call", FOLDER_SLUG, "read", ...legacyValues);
		legacyInsert.run(sessionFile, "v1-asst", "v1-direct-call", FOLDER_SLUG, "read", ...legacyValues);
		legacyInsert.run(
			"/tmp/unavailable.jsonl",
			"unavailable-entry",
			"unavailable-call",
			FOLDER_SLUG,
			"read",
			...legacyValues,
		);
		legacy.close();

		await initDb();
		const migrated = new Database(getStatsDbPath(), { readonly: true });
		const columns = migrated.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ name: string }>;
		const invocationTable = migrated
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_invocations'")
			.get() as { name: string } | undefined;
		const pending = migrated.prepare("SELECT value FROM meta WHERE key = ?").get("tool_calls_v2") as {
			value: string;
		};
		migrated.close();
		expect(columns.some(column => column.name === "skill_name")).toBe(true);
		expect(invocationTable).toEqual({ name: "skill_invocations" });
		expect(pending).toEqual({ value: "pending" });
		expect(getFileOffset(sessionFile)).toBeNull();

		await syncAllSessions({ workers: 1 });
		const afterSync = new Database(getStatsDbPath(), { readonly: true });
		const directChild = afterSync
			.prepare("SELECT skill_name, target FROM skill_invocations WHERE tool_call_id = ?")
			.get("v1-direct-call") as { skill_name: string; target: string | null } | null;
		const delimitedChild = afterSync
			.prepare("SELECT skill_name, target FROM skill_invocations WHERE tool_call_id = ?")
			.get("v1-delimited-call") as { skill_name: string; target: string | null } | null;
		const settled = afterSync.prepare("SELECT value FROM meta WHERE key = ?").get("tool_calls_v2") as {
			value: string;
		};
		const toolRows = afterSync
			.prepare("SELECT session_file, tool_call_id, skill_name FROM tool_calls ORDER BY session_file, tool_call_id")
			.all() as Array<{ session_file: string; tool_call_id: string; skill_name: string | null }>;
		afterSync.close();
		expect(directChild).toEqual({ skill_name: "direct", target: null });
		expect(delimitedChild).toBeNull();
		expect(settled).toEqual({ value: "complete" });
		expect(toolRows).toEqual([
			{ session_file: "/tmp/unavailable.jsonl", tool_call_id: "unavailable-call", skill_name: null },
			{ session_file: sessionFile, tool_call_id: "v1-delimited-call", skill_name: null },
			{ session_file: sessionFile, tool_call_id: "v1-direct-call", skill_name: "direct" },
		]);
	});
});
