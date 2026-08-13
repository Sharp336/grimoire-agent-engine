import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ingestSessionDetail,
	resolveLeadSessionFile,
	syncAllSessions,
} from "@oh-my-pi/omp-stats/aggregator";
import { getFileOffset, initDb } from "@oh-my-pi/omp-stats/db";
import { STATS_ENTRY_TABLES, STATS_SESSION_TABLES } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { __internalsForTesting } from "@oh-my-pi/pi-utils/file-lock";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-observability-");

function header(id: string, title = "alpha") {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-08-13T10:00:00.000Z",
		cwd: "/tmp/project",
		title,
	};
}

function custom(id: string, kind: string, data: Record<string, unknown> = {}, timestamp = "2026-08-13T10:01:00.000Z") {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp,
		customType: "observability",
		data: { v: 1, kind, ...data },
	};
}

async function createLead(id: string, entries: unknown[] = [], title = "alpha"): Promise<string> {
	const project = path.join(getSessionsDir(), "--tmp--observability");
	await fs.mkdir(project, { recursive: true });
	const file = path.join(project, `2026-08-13_${id}.jsonl`);
	await Bun.write(file, `${[header(id, title), ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

async function completeBackfill(): Promise<void> {
	await syncAllSessions({ workers: 1 });
}

describe("observability targeted ingest", () => {
	it("indexes a complete appended line without a full sync", async () => {
		const file = await createLead("session-append");
		await completeBackfill();
		const before = getFileOffset(file)!;
		await fs.appendFile(file, `${JSON.stringify(custom("obs-1", "segment", { segmentId: "s1" }))}\n`);

		const result = await ingestSessionDetail("session-append");
		const database = await initDb();
		const row = database.prepare("SELECT kind FROM obs_timeline WHERE entry_id = ?").get("obs-1") as { kind: string };

		expect(result.ok).toBe(true);
		expect(row.kind).toBe("segment");
		expect(getFileOffset(file)!.offset).toBeGreaterThan(before.offset);
		expect(getFileOffset(file)!.offset).toBe((await fs.stat(file)).size);
	});

	it("does not consume an incomplete trailing line and later indexes it once", async () => {
		const file = await createLead("session-partial");
		await completeBackfill();
		const before = getFileOffset(file)!;
		const line = JSON.stringify(custom("obs-partial", "verification"));
		await fs.appendFile(file, line.slice(0, 20));
		await ingestSessionDetail("session-partial");
		expect(getFileOffset(file)!.offset).toBe(before.offset);

		await fs.appendFile(file, `${line.slice(20)}\n`);
		await ingestSessionDetail("session-partial");
		const database = await initDb();
		const count = database.prepare("SELECT count(*) AS count FROM obs_timeline WHERE entry_id = ?").get("obs-partial") as {
			count: number;
		};
		expect(count.count).toBe(1);
		expect(getFileOffset(file)!.offset).toBe((await fs.stat(file)).size);
	});

	it("refreshes title metadata at EOF without bumping generation", async () => {
		const file = await createLead("session-title", [], "alpha");
		await completeBackfill();
		const before = getFileOffset(file)!;
		const text = await Bun.file(file).text();
		const position = text.indexOf("alpha");
		const handle = await fs.open(file, "r+");
		try {
			await handle.write(Buffer.from("bravo"), 0, 5, position);
		} finally {
			await handle.close();
		}
		const now = new Date(Date.now() + 2_000);
		await fs.utimes(file, now, now);

		await ingestSessionDetail("session-title");
		const database = await initDb();
		const session = database.prepare("SELECT title, generation FROM obs_sessions WHERE id = ?").get("session-title") as {
			title: string;
			generation: number;
		};
		expect(session).toEqual({ title: "bravo", generation: before.generation });
		expect(getFileOffset(file)!.offset).toBe(before.offset);
	});

	it("resets a truncated source and increments generation", async () => {
		const file = await createLead("session-rewrite", [custom("old", "segment", { segmentId: "old" })]);
		await completeBackfill();
		const before = getFileOffset(file)!;
		await Bun.write(file, `${JSON.stringify(header("session-rewrite"))}\n`);

		await ingestSessionDetail("session-rewrite");
		const after = getFileOffset(file)!;
		expect(after.generation).toBe(before.generation + 1);
		expect(after.offset).toBe((await fs.stat(file)).size);
	});

	it("classifies nested and advisor transcripts without creating Session rows", async () => {
		const lead = await createLead("session-related");
		const stem = lead.slice(0, -".jsonl".length);
		await fs.mkdir(stem, { recursive: true });
		await Bun.write(path.join(stem, "child-id.jsonl"), `${JSON.stringify(header("child-id"))}\n`);
		await Bun.write(path.join(stem, "__advisor.review.jsonl"), `${JSON.stringify(header("advisor-id"))}\n`);

		await completeBackfill();
		const database = await initDb();
		const sessions = database.prepare("SELECT count(*) AS count FROM obs_sessions").get() as { count: number };
		const related = database.prepare("SELECT kind FROM obs_related_transcripts ORDER BY kind").all() as Array<{ kind: string }>;
		expect(sessions.count).toBe(1);
		expect(related.map(row => row.kind)).toEqual(["advisor", "nested"]);
	});

	it("indexes only stored facts and creates Runs only from run_assignment", async () => {
		await createLead("session-facts", [
			custom("segment-1", "segment", { segmentId: "s1" }),
			custom("verification-1", "verification"),
			custom("verdict-1", "human_verdict"),
			custom("outcome-1", "outcome", { execution: "completed" }),
		]);
		await createLead("session-empty");
		await completeBackfill();
		const database = await initDb();
		const kinds = database.prepare("SELECT kind FROM obs_timeline ORDER BY kind").all() as Array<{ kind: string }>;
		const runs = database.prepare("SELECT count(*) AS count FROM obs_runs").get() as { count: number };
		expect(kinds.map(row => row.kind)).toEqual(["human_verdict", "outcome", "segment", "verification"]);
		expect(runs.count).toBe(0);
	});

	it("resolves unknown ids only from project-folder lead files", async () => {
		const lead = await createLead("unknown-live");
		const otherStem = path.join(path.dirname(lead), "unrelated");
		await fs.mkdir(otherStem, { recursive: true });
		await Bun.write(path.join(otherStem, "2026_stem-only.jsonl"), `${JSON.stringify(header("stem-only"))}\n`);

		expect(await resolveLeadSessionFile("unknown-live")).toBe(lead);
		expect(await resolveLeadSessionFile("stem-only")).toBeNull();
		expect(await ingestSessionDetail("missing")).toEqual({ ok: false, reason: "not_found" });
	});

	it("returns to a non-terminal status when a boundary follows session_exit", async () => {
		const exit = {
			type: "custom",
			id: "exit-1",
			parentId: null,
			timestamp: "2026-08-13T10:02:00.000Z",
			customType: "session_exit",
			data: { kind: "normal", reason: "quit", recordedAt: "2026-08-13T10:02:00.000Z" },
		};
		const file = await createLead("session-resume", [exit]);
		await completeBackfill();
		const database = await initDb();
		expect((database.prepare("SELECT status FROM obs_sessions WHERE id = ?").get("session-resume") as { status: string }).status).toBe("completed");

		await fs.appendFile(
			file,
			`${JSON.stringify(custom("boundary-1", "session_boundary", { reason: "resume" }, "2026-08-13T10:03:00.000Z"))}\n`,
		);
		await ingestSessionDetail("session-resume");
		expect((database.prepare("SELECT status FROM obs_sessions WHERE id = ?").get("session-resume") as { status: string }).status).toBe("active");
	});

	it("does not advance file offsets while the observability backfill is pending", async () => {
		const file = await createLead("session-pending", [custom("pending-obs", "segment", { segmentId: "p" })]);
		const targeted = await ingestSessionDetail("session-pending");
		const database = await initDb();
		expect(targeted.ok).toBe(true);
		expect(targeted.ok && targeted.observability.map(event => event.entryId)).toEqual(["pending-obs"]);
		expect(database.prepare("SELECT last_modified FROM file_offsets WHERE session_file = ?").get(file)).toBeNull();

		await completeBackfill();
		expect(getFileOffset(file)!.offset).toBe((await fs.stat(file)).size);
		expect((database.prepare("SELECT count(*) AS count FROM obs_timeline WHERE entry_id = ?").get("pending-obs") as { count: number }).count).toBe(1);
	});

	it("returns lock_busy with the last SQLite snapshot", async () => {
		await createLead("session-locked");
		await completeBackfill();
		const lockPath = __internalsForTesting.getLockPath(`${getStatsDbPath()}.sync`);
		const lock = __internalsForTesting.tryAcquireLock(lockPath);
		expect(lock).not.toBeNull();
		try {
			const result = await ingestSessionDetail("session-locked");
			expect(result.ok).toBe(false);
			expect(!result.ok && result.reason).toBe("lock_busy");
			expect(!result.ok && result.snapshot?.id).toBe("session-locked");
		} finally {
			lock?.release();
		}
	});

	it("registers new session-scoped observability tables with GC", () => {
		expect(STATS_SESSION_TABLES).toEqual(
			expect.arrayContaining([
				"obs_sessions",
				"obs_related_transcripts",
				"obs_run_assignments",
				"obs_timeline",
				"file_offsets",
			]),
		);
		expect(STATS_ENTRY_TABLES).toEqual(expect.arrayContaining(["obs_run_assignments", "obs_timeline"]));
		expect(STATS_SESSION_TABLES).not.toContain("obs_audit_offsets");
		expect(STATS_SESSION_TABLES).not.toContain("obs_routing_audit");
		expect(STATS_SESSION_TABLES).not.toContain("obs_runs");
	});
});
