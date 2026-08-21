import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { dedupeProjects, getGainDashboardStats, normalizeProjectPath } from "@oh-my-pi/omp-stats/gain-aggregator";
import { getAgentDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

// ---------------------------------------------------------------------------
// normalizeProjectPath — pure, table-driven
// ---------------------------------------------------------------------------

describe("normalizeProjectPath", () => {
	it("returns null for temp paths", () => {
		expect(normalizeProjectPath("/var/folders/abc/def")).toBeNull();
		expect(normalizeProjectPath("/tmp/session-abc")).toBeNull();
		expect(normalizeProjectPath("/Users/x/T/run")).toBeNull();
		expect(normalizeProjectPath("/pi-bash-exec/foo")).toBeNull();
	});

	it("keeps project paths that merely contain a var/folders segment", () => {
		expect(normalizeProjectPath("/srv/project/var/folders/app")).toBe("/srv/project/var/folders/app");
	});

	it("returns null for omp internal worktrees", () => {
		expect(normalizeProjectPath("/Users/x/.omp/wt/3543-abc/packages/stats")).toBeNull();
	});

	it("strips .wt/ worktree suffix", () => {
		expect(normalizeProjectPath("/Users/x/myrepo/.wt/feat-lane/src")).toBe("/Users/x/myrepo");
	});

	it("strips -wt/ worktree suffix", () => {
		expect(normalizeProjectPath("/Users/x/myrepo-wt/main/src/packages")).toBe("/Users/x/myrepo");
	});

	it("strips .worktrees/ worktree suffix", () => {
		expect(normalizeProjectPath("/Users/x/myrepo/.worktrees/lane-a")).toBe("/Users/x/myrepo");
	});

	it("strips -worktrees/ worktree suffix", () => {
		expect(normalizeProjectPath("/Users/x/myrepo-worktrees/feat-lane/packages/foo")).toBe("/Users/x/myrepo");
	});

	it("strips generic /<dir>/worktrees/ suffix (e.g. .herdr/worktrees)", () => {
		expect(normalizeProjectPath("/Users/x/myrepo/.herdr/worktrees/lane-name/src")).toBe("/Users/x/myrepo");
	});

	it("returns the path unchanged for ordinary project dirs", () => {
		expect(normalizeProjectPath("/Users/x/my-project/src")).toBe("/Users/x/my-project/src");
		expect(normalizeProjectPath("/Users/x/my-project")).toBe("/Users/x/my-project");
	});
});

// ---------------------------------------------------------------------------
// dedupeProjects — prefix dedup with depth ≥ 4 guard
// ---------------------------------------------------------------------------

describe("dedupeProjects", () => {
	it("returns empty array for empty input", () => {
		expect(dedupeProjects(new Set())).toEqual([]);
	});

	it("drops temp paths", () => {
		const result = dedupeProjects(new Set(["/tmp/foo", "/var/folders/x/y"]));
		expect(result).toEqual([]);
	});

	it("deduplicates worktree sub-paths to their project root", () => {
		// /home/runner/work/myrepo (depth=4) subsumes deeper paths from its worktrees
		const raw = new Set([
			"/home/runner/work/myrepo/.wt/feat/src",
			"/home/runner/work/myrepo/.wt/main",
			"/home/runner/work/myrepo/packages/stats",
		]);
		const result = dedupeProjects(raw);
		// All three normalize to /home/runner/work/myrepo or a sub-path thereof.
		// /home/runner/work/myrepo (depth=4) subsumes /home/runner/work/myrepo/packages/stats (depth=6).
		expect(result).toEqual(["/home/runner/work/myrepo"]);
	});

	it("drops sub-paths when parent is at depth >= 4", () => {
		// /a/b/c/d (depth=4) is a prefix of /a/b/c/d/child (depth=5) → child is dropped
		const raw = new Set(["/a/b/c/d", "/a/b/c/d/child"]);
		const result = dedupeProjects(raw);
		expect(result).toEqual(["/a/b/c/d"]);
	});

	it("keeps both when parent is too shallow (depth < 4)", () => {
		// /Users/x (depth=3) is too shallow — does not subsume child
		const raw = new Set(["/Users/x", "/Users/x/child"]);
		const result = dedupeProjects(raw);
		expect(result.sort()).toEqual(["/Users/x", "/Users/x/child"].sort());
	});

	it("keeps distinct sibling projects", () => {
		const raw = new Set(["/Users/x/proj-a", "/Users/x/proj-b"]);
		const result = dedupeProjects(raw);
		expect(result.sort()).toEqual(["/Users/x/proj-a", "/Users/x/proj-b"].sort());
	});

	it("prefix match requires path separator — /foo/bar does not subsume /foo/barbaz", () => {
		const raw = new Set(["/Users/x/foo/bar", "/Users/x/foo/barbaz"]);
		const result = dedupeProjects(raw);
		expect(result.sort()).toEqual(["/Users/x/foo/bar", "/Users/x/foo/barbaz"].sort());
	});
});

// ---------------------------------------------------------------------------
// getGainDashboardStats — fixture JSONL / JSON integration
// ---------------------------------------------------------------------------

installStatsTestIsolation("@pi-stats-gain-");

/** Write a minimizer-gain.jsonl with the given records into the temp agent dir. */
async function writeMinimizerJSONL(records: object[]): Promise<void> {
	const agentDir = getAgentDir();
	await fs.mkdir(agentDir, { recursive: true });
	const lines = records.map(r => JSON.stringify(r)).join("\n");
	await Bun.write(path.join(agentDir, "minimizer-gain.jsonl"), lines);
}

/** Write Snapcompact savings alongside stats.db. */
async function writeSnapcompactJSONL(records: object[]): Promise<void> {
	const lines = records.map(r => JSON.stringify(r)).join("\n");
	await Bun.write(path.join(path.dirname(getStatsDbPath()), "snapcompact-savings.jsonl"), lines);
}

describe("getGainDashboardStats", () => {
	it("returns zero totals when no files exist", async () => {
		const stats = await getGainDashboardStats();
		expect(stats.overall.savedTokens).toBe(0);
		expect(stats.overall.hits).toBe(0);
		expect(stats.projects).toEqual([]);
		expect(stats.missedCommands).toEqual([]);
	});

	it("aggregates saved minimizer records into totals", async () => {
		const now = new Date().toISOString();
		await writeMinimizerJSONL([
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
		]);

		const stats = await getGainDashboardStats();
		expect(stats.overall.savedTokens).toBe(300);
		expect(stats.overall.hits).toBe(2);
		expect(stats.bySource.minimizer.savedTokens).toBe(300);
		expect(stats.bySource.minimizer.hits).toBe(2);
		// top filters should include git-status
		expect(stats.topFilters).toHaveLength(1);
		expect(stats.topFilters[0]!.filter).toBe("git-status");
		expect(stats.topFilters[0]!.hits).toBe(2);
	});

	it("collects missed commands aggregated by full command string", async () => {
		const now = new Date().toISOString();
		await writeMinimizerJSONL([
			{
				timestamp: now,
				filter: "missed",
				command: "git status --short",
				inputBytes: 500,
				outputBytes: 500,
				savedBytes: 0,
				kind: "missed",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: now,
				filter: "missed",
				command: "git status --short",
				inputBytes: 600,
				outputBytes: 600,
				savedBytes: 0,
				kind: "missed",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: now,
				filter: "missed",
				command: "bun run check:types",
				inputBytes: 2000,
				outputBytes: 2000,
				savedBytes: 0,
				kind: "missed",
				cwd: "/Users/x/myrepo",
			},
		]);

		const stats = await getGainDashboardStats();
		// Sorted by hits descending
		expect(stats.missedCommands).toHaveLength(2);
		expect(stats.missedCommands[0]!.command).toBe("git status --short");
		expect(stats.missedCommands[0]!.hits).toBe(2);
		expect(stats.missedCommands[1]!.command).toBe("bun run check:types");
		expect(stats.missedCommands[1]!.hits).toBe(1);
	});

	it("retains a project containing var/folders in dashboard selections and missed-command tuning", async () => {
		const project = "/srv/project/var/folders/app";
		await writeMinimizerJSONL([
			{
				timestamp: new Date().toISOString(),
				filter: "missed",
				command: "git status --short",
				inputBytes: 500,
				outputBytes: 500,
				savedBytes: 0,
				kind: "missed",
				cwd: project,
			},
		]);

		const stats = await getGainDashboardStats();
		expect(stats.projects).toEqual([project]);
		expect(stats.missedCommands).toEqual([expect.objectContaining({ command: "git status --short", hits: 1 })]);
	});

	it("skips minimizer records with invalid timestamps", async () => {
		const now = new Date().toISOString();
		await writeMinimizerJSONL([
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: "not-a-date",
				filter: "git-log",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
			{
				filter: "missed",
				command: "git status --short",
				inputBytes: 500,
				outputBytes: 500,
				savedBytes: 0,
				kind: "missed",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: null,
				filter: "null-timestamp",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: 0,
				filter: "numeric-timestamp",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: "0",
				filter: "coerced-timestamp",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: "2026-07-30T00:00:00Z",
				filter: "non-writer-iso-timestamp",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
		]);

		const stats = await getGainDashboardStats();
		expect(stats.bySource.minimizer.hits).toBe(1);
		expect(stats.topFilters).toEqual([expect.objectContaining({ filter: "git-status", hits: 1 })]);
		expect(stats.missedCommands).toEqual([]);
	});

	it("skips minimizer records with a literal NaN timestamp without crashing", async () => {
		// NaN is not valid JSON, so a writer bug that serialized a bare NaN token
		// (rather than JSON.stringify's usual NaN -> null coercion) must still be
		// dropped as a malformed line rather than throwing or bucketing garbage.
		const now = new Date().toISOString();
		const validLine = JSON.stringify({
			timestamp: now,
			filter: "git-status",
			inputBytes: 1000,
			outputBytes: 200,
			savedBytes: 800,
			savedTokens: 200,
			kind: "saved",
			cwd: "/Users/x/myrepo",
		});
		const nanLine = JSON.stringify({
			filter: "nan-timestamp",
			inputBytes: 500,
			outputBytes: 100,
			savedBytes: 400,
			savedTokens: 100,
			kind: "saved",
			cwd: "/Users/x/myrepo",
		}).replace('"filter"', '"timestamp":NaN,"filter"');

		const agentDir = getAgentDir();
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "minimizer-gain.jsonl"), `${validLine}\n${nanLine}\n`);

		const stats = await getGainDashboardStats();
		expect(stats.bySource.minimizer.hits).toBe(1);
		expect(stats.topFilters).toEqual([expect.objectContaining({ filter: "git-status", hits: 1 })]);
	});

	it("rejects a calendar-invalid timestamp that Date rolls over to a different day", async () => {
		// Feb 30 doesn't exist; JS Date silently rolls it to Mar 2. The writer
		// never produces this shape, but the round-trip check must reject it
		// rather than bucket the record under the wrong day.
		await writeMinimizerJSONL([
			{
				timestamp: "2026-02-30T00:00:00.000Z",
				filter: "rollover-timestamp",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
		]);

		const stats = await getGainDashboardStats();
		expect(stats.bySource.minimizer.hits).toBe(0);
	});

	it("project filter scopes minimizer records", async () => {
		const now = new Date().toISOString();
		await writeMinimizerJSONL([
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/proj-a",
			},
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/proj-b",
			},
		]);

		const statsA = await getGainDashboardStats(null, "/Users/x/proj-a");
		expect(statsA.bySource.minimizer.hits).toBe(1);
		expect(statsA.bySource.minimizer.savedTokens).toBe(200);

		const statsB = await getGainDashboardStats(null, "/Users/x/proj-b");
		expect(statsB.bySource.minimizer.hits).toBe(1);
		expect(statsB.bySource.minimizer.savedTokens).toBe(100);
	});

	it("attributes an external execution cwd to its session project without changing ordinary cwd records", async () => {
		const now = new Date().toISOString();
		await writeMinimizerJSONL([
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/external-repo",
				sessionCwd: "/Users/x/proj-a",
			},
			{
				timestamp: now,
				filter: "git-log",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/proj-b",
				sessionCwd: "/Users/x/proj-b",
			},
		]);

		const statsA = await getGainDashboardStats(null, "/Users/x/proj-a");
		expect(statsA.bySource.minimizer).toEqual(expect.objectContaining({ hits: 1, savedTokens: 200 }));
		expect(statsA.topFilters).toEqual([expect.objectContaining({ filter: "git-status", hits: 1 })]);

		const statsB = await getGainDashboardStats(null, "/Users/x/proj-b");
		expect(statsB.bySource.minimizer).toEqual(expect.objectContaining({ hits: 1, savedTokens: 100 }));
		expect(statsB.topFilters).toEqual([expect.objectContaining({ filter: "git-log", hits: 1 })]);

		const unfiltered = await getGainDashboardStats();
		expect(unfiltered.projects).toEqual(["/Users/x/proj-a", "/Users/x/proj-b"]);
	});

	it("project filter is separator-safe — /foo/bar does not match /foo/barbaz", async () => {
		const now = new Date().toISOString();
		await writeMinimizerJSONL([
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/foo/bar",
			},
			{
				timestamp: now,
				filter: "git-log",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/foo/barbaz",
			},
		]);

		const stats = await getGainDashboardStats(null, "/Users/x/foo/bar");
		expect(stats.bySource.minimizer.hits).toBe(1);
		expect(stats.topFilters[0]!.filter).toBe("git-status");
	});

	it("time range cutoff filters old records", async () => {
		const recent = new Date().toISOString();
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
		await writeMinimizerJSONL([
			{
				timestamp: recent,
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
			{
				timestamp: old,
				filter: "git-log",
				inputBytes: 500,
				outputBytes: 100,
				savedBytes: 400,
				savedTokens: 100,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
		]);

		const stats = await getGainDashboardStats("24h");
		// Only the recent record passes the 24h cutoff
		expect(stats.bySource.minimizer.hits).toBe(1);
		expect(stats.topFilters[0]!.filter).toBe("git-status");

		const allStats = await getGainDashboardStats("all");
		expect(allStats.bySource.minimizer.hits).toBe(2);
	});

	it("overall.reductionPercent uses only sources with originalBytes", async () => {
		const now = new Date().toISOString();
		await writeMinimizerJSONL([
			{
				timestamp: now,
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
		]);
		const stats = await getGainDashboardStats();
		// reductionPercent = savedBytes / originalBytes = 800/1000 = 0.8
		expect(stats.bySource.minimizer.reductionPercent).toBe(0.8);
		// overall also 0.8 (only minimizer has originalBytes here)
		expect(stats.overall.reductionPercent).toBe(0.8);
	});

	it("does not label a mixed-source total with a minimizer-only reduction", async () => {
		const now = new Date();
		await writeMinimizerJSONL([
			{
				timestamp: now.toISOString(),
				filter: "git-status",
				inputBytes: 1000,
				outputBytes: 200,
				savedBytes: 800,
				savedTokens: 200,
				kind: "saved",
				cwd: "/Users/x/myrepo",
			},
		]);
		await writeSnapcompactJSONL([
			{
				ts: now.getTime(),
				session: "test-session",
				provider: "test",
				model: "test",
				toolCallId: "test-call",
				savedTokens: 100,
			},
		]);

		const stats = await getGainDashboardStats();
		expect(stats.overall.savedTokens).toBe(300);
		expect(stats.overall.savedBytes).toBe(1200);
		expect(stats.overall.hits).toBe(2);
		expect(stats.bySource.minimizer.reductionPercent).toBe(0.8);
		expect(stats.bySource.snapcompact.reductionPercent).toBeNull();
		expect(stats.overall.reductionPercent).toBeNull();
	});
});
