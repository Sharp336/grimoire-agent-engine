import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-message-metadata-");

const BASE_TS = Date.parse("2026-06-30T12:00:00.000Z");
const BASE_ISO = new Date(BASE_TS).toISOString();

async function writeSession(name: string, lines: Array<Record<string, unknown>>): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--message-metadata");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return filePath;
}

function sessionEntry(id = "session-message-metadata"): Record<string, unknown> {
	return {
		type: "session",
		version: 1,
		id,
		timestamp: BASE_ISO,
		cwd: "/tmp/message-metadata",
	};
}

function thinkingLevelEntry(opts: {
	id: string;
	configured?: string | null;
	thinkingLevel?: string | null;
}): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		type: "thinking_level_change",
		id: opts.id,
		timestamp: BASE_ISO,
	};
	if (opts.configured !== undefined) entry.configured = opts.configured;
	if (opts.thinkingLevel !== undefined) entry.thinkingLevel = opts.thinkingLevel;
	return entry;
}

function assistantEntry(opts: {
	id: string;
	timestampOffsetMs?: number;
	planId?: string | null;
}): Record<string, unknown> {
	const timestamp = BASE_TS + (opts.timestampOffsetMs ?? 0);
	const entry: Record<string, unknown> = {
		type: "message",
		id: opts.id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: `reply ${opts.id}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 1,
				cacheWrite: 2,
				totalTokens: 18,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
			duration: 123,
			ttft: 45,
		},
	};
	if (opts.planId !== undefined) entry.planId = opts.planId;
	return entry;
}

describe("message metadata parsing and persistence", () => {
	it("stamps assistant messages with the running thinking level and resolves auto to the concrete level", async () => {
		const sessionFile = await writeSession("thinking-levels.jsonl", [
			sessionEntry(),
			assistantEntry({ id: "before-thinking-level", timestampOffsetMs: 1 }),
			thinkingLevelEntry({ id: "tl-auto-medium", configured: "auto", thinkingLevel: "medium" }),
			assistantEntry({ id: "after-auto", timestampOffsetMs: 2 }),
			thinkingLevelEntry({ id: "tl-low", configured: "low" }),
			assistantEntry({ id: "after-low", timestampOffsetMs: 3 }),
		]);

		const result = await parseSessionFile(sessionFile);

		expect(result.stats.map(stat => [stat.entryId, stat.thinkingLevel])).toEqual([
			["before-thinking-level", null],
			["after-auto", "medium"],
			["after-low", "low"],
		]);
	});

	it("carries the latest prefix thinking level into an incremental parse", async () => {
		const sessionFile = await writeSession("incremental-thinking-level.jsonl", [
			sessionEntry(),
			thinkingLevelEntry({ id: "tl-prefix-low", configured: "low" }),
			thinkingLevelEntry({ id: "tl-prefix-auto-high", configured: "auto", thinkingLevel: "high" }),
			assistantEntry({ id: "incremental-assistant", timestampOffsetMs: 1 }),
		]);
		const bytes = await fs.readFile(sessionFile);
		const lastThinkingLevelStart = bytes.indexOf(Buffer.from("tl-prefix-auto-high"));
		const offset = bytes.indexOf(0x0a, lastThinkingLevelStart) + 1;
		expect(lastThinkingLevelStart).toBeGreaterThan(0);
		expect(offset).toBeGreaterThan(lastThinkingLevelStart);

		const result = await parseSessionFile(sessionFile, offset);

		expect(result.stats).toHaveLength(1);
		expect(result.stats[0]?.entryId).toBe("incremental-assistant");
		expect(result.stats[0]?.thinkingLevel).toBe("high");
	});

	it("copies planId from session messages and persists both metadata columns through recent requests", async () => {
		const sessionFile = await writeSession("metadata-columns.jsonl", [
			sessionEntry(),
			thinkingLevelEntry({ id: "tl-auto-medium", configured: "auto", thinkingLevel: "medium" }),
			assistantEntry({ id: "with-plan", timestampOffsetMs: 1, planId: "anthropic:5h" }),
		]);
		const parsed = await parseSessionFile(sessionFile);
		expect(parsed.stats).toHaveLength(1);
		expect(parsed.stats[0]?.thinkingLevel).toBe("medium");
		expect(parsed.stats[0]?.planId).toBe("anthropic:5h");

		await initDb();
		expect(insertMessageStats(parsed.stats)).toBe(1);

		const request = getRecentRequests(1)[0];
		expect(request?.entryId).toBe("with-plan");
		expect(request?.thinkingLevel).toBe("medium");
		expect(request?.planId).toBe("anthropic:5h");
	});

	it("updates existing rows on re-sync when the parser later supplies metadata", async () => {
		const sessionFile = await writeSession("resync-metadata.jsonl", [
			sessionEntry(),
			thinkingLevelEntry({ id: "tl-auto-high", configured: "auto", thinkingLevel: "high" }),
			assistantEntry({ id: "resynced-assistant", timestampOffsetMs: 1, planId: "anthropic:5h" }),
		]);
		const parsed = await parseSessionFile(sessionFile);
		const reparsedStat = parsed.stats[0];
		if (!reparsedStat) throw new Error("expected parsed assistant stat");
		const staleStat: MessageStats = { ...reparsedStat, thinkingLevel: null, planId: null };

		await initDb();
		expect(insertMessageStats([staleStat])).toBe(1);
		expect(getRecentRequests(1)[0]?.thinkingLevel).toBeNull();
		expect(getRecentRequests(1)[0]?.planId).toBeNull();

		expect(insertMessageStats([reparsedStat])).toBe(1);
		const matching = getRecentRequests(10).filter(request => request.entryId === "resynced-assistant");
		expect(matching).toHaveLength(1);
		expect(matching[0]?.thinkingLevel).toBe("high");
		expect(matching[0]?.planId).toBe("anthropic:5h");
	});
});
