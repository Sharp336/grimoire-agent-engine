import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { searchArchivedSessionTranscripts } from "../../src/session/session-archive";
import { SessionSearchTool } from "../../src/tools/session-search";

interface FixtureEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

function sessionFixture(id: string, cwd: string, title: string, entries: FixtureEntry[]): string {
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-07-21T12:00:00.000Z",
		cwd,
		title,
	};
	return `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

let tempDir: string;
let originalAgentDir: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-search-"));
	setAgentDir(path.join(tempDir, "agent"));
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("session transcript search", () => {
	it("searches pre-compaction entries literally with stable pagination and role filters", async () => {
		const cwd = path.join(tempDir, "project");
		const sessionsDir = path.join(getAgentDir(), "sessions", "project");
		await fs.mkdir(sessionsDir, { recursive: true });
		const oldId = "019f2000-aaaa-7000-8000-000000000001";
		const newId = "019f2000-bbbb-7000-8000-000000000002";
		const oldFile = path.join(sessionsDir, `2026-07-21T12-00-00-000Z_${oldId}.jsonl`);
		const newFile = path.join(sessionsDir, `2026-07-21T13-00-00-000Z_${newId}.jsonl`);
		await Bun.write(
			oldFile,
			sessionFixture(oldId, cwd, "Older session", [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-07-21T12:01:00.000Z",
					message: { role: "user", content: "Before compact Needle.literal[]", timestamp: 1 },
				},
				{
					type: "compaction",
					id: "c1",
					parentId: "u1",
					timestamp: "2026-07-21T12:02:00.000Z",
					summary: "Summary needle",
				},
				{
					type: "message",
					id: "t1",
					parentId: "c1",
					timestamp: "2026-07-21T12:03:00.000Z",
					message: { role: "toolResult", content: [{ type: "text", text: "tool needle" }], timestamp: 2 },
				},
				{
					type: "message",
					id: "a1",
					parentId: "t1",
					timestamp: "2026-07-21T12:04:00.000Z",
					message: { role: "assistant", content: [{ type: "text", text: "assistant needle" }], timestamp: 3 },
				},
				{
					type: "custom_message",
					id: "x1",
					parentId: "a1",
					timestamp: "2026-07-21T12:05:00.000Z",
					content: "custom needle",
					display: true,
				},
			]),
		);
		await Bun.write(
			newFile,
			sessionFixture(newId, cwd, "Newer session", [
				{
					type: "message",
					id: "n1",
					parentId: null,
					timestamp: "2026-07-21T13:01:00.000Z",
					message: { role: "user", content: "newest needle", timestamp: 4 },
				},
			]),
		);
		await fs.utimes(oldFile, new Date(1_000), new Date(1_000));
		await fs.utimes(newFile, new Date(2_000), new Date(2_000));

		const firstPage = await searchArchivedSessionTranscripts({ query: "needle", cwd, limit: 2 });
		expect(firstPage.matches.map(match => match.entryId)).toEqual(["n1", "x1"]);
		expect(firstPage.hasMore).toBe(true);
		expect(firstPage.nextOffset).toBe(2);

		const secondPage = await searchArchivedSessionTranscripts({ query: "needle", cwd, limit: 2, offset: 2 });
		expect(secondPage.matches.map(match => match.entryId)).toEqual(["a1", "t1"]);
		expect(secondPage.nextOffset).toBe(4);

		const lastPage = await searchArchivedSessionTranscripts({ query: "needle", cwd, limit: 2, offset: 4 });
		expect(lastPage.matches.map(match => match.entryId)).toEqual(["c1", "u1"]);
		expect(lastPage.hasMore).toBe(false);

		const preCompaction = await searchArchivedSessionTranscripts({
			query: "needle.literal[]",
			cwd,
			session: "019f2000-a",
			role: "user",
		});
		expect(preCompaction.matches.map(match => match.entryId)).toEqual(["u1"]);
		expect(preCompaction.matches[0]?.snippet).toContain("Needle.literal[]");

		const caseSensitive = await searchArchivedSessionTranscripts({
			query: "needle.literal[]",
			cwd,
			session: oldId,
			role: "user",
			caseSensitive: true,
		});
		expect(caseSensitive.matches).toEqual([]);

		const summary = await searchArchivedSessionTranscripts({ query: "summary", cwd, role: "summary" });
		expect(summary.matches.map(match => match.entryId)).toEqual(["c1"]);
	});

	it("returns bounded tool output with a resolvable history URL", async () => {
		const cwd = path.join(tempDir, "project");
		const sessionsDir = path.join(getAgentDir(), "sessions", "project");
		await fs.mkdir(sessionsDir, { recursive: true });
		const id = "019f3000-aaaa-7000-8000-000000000001";
		await Bun.write(
			path.join(sessionsDir, `2026-07-21T12-00-00-000Z_${id}.jsonl`),
			sessionFixture(id, cwd, "Tool contract", [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-07-21T12:01:00.000Z",
					message: { role: "user", content: "find this durable phrase", timestamp: 1 },
				},
			]),
		);
		const tool = new SessionSearchTool({ cwd } as ToolSession);

		const result = await tool.execute("call-1", { query: "durable phrase", limit: 1 });

		if (!result.details) throw new Error("Expected structured session search details");
		expect(result.details.matches).toHaveLength(1);
		expect(result.details.matches[0]?.sessionId).toBe(id);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text tool output");
		expect(result.content[0].text).toContain(`history://session/${id}`);
		expect(result.content[0].text).toContain("find this durable phrase");
		expect(result.content[0].text.length).toBeLessThan(2_000);
	});
});
