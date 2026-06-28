import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import type { SessionHealthStats } from "@oh-my-pi/omp-stats/types";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-session-health-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

const timestamp = Date.parse("2026-06-27T00:00:00.000Z");

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	premiumRequests: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function writeHealthSessionFiles(): Promise<{ mainFile: string; subagentFile: string }> {
	const folder = path.join(getAgentDir(), "sessions", "--tmp--session-health");
	const mainFile = path.join(folder, "session.jsonl");
	const subagentFile = path.join(folder, "session", "subagent.jsonl");
	const mainEntries = [
		{
			type: "model_change",
			id: "model-1",
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			model: "openai/gpt-4.1",
		},
		{
			type: "model_change",
			id: "model-2",
			parentId: "model-1",
			timestamp: new Date(timestamp + 30_000).toISOString(),
			model: "openai/gpt-5",
		},
		{
			type: "compaction",
			id: "compact-1",
			parentId: "model-1",
			timestamp: new Date(timestamp + 60_000).toISOString(),
			summary: "summary",
			firstKeptEntryId: "model-1",
			tokensBefore: 1234,
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp: new Date(timestamp + 120_000).toISOString(),
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "read-1", name: "read", arguments: {} },
					{ type: "text", text: "thinking between duplicate reads should not break loop detection" },
					{ type: "toolCall", id: "read-2", name: "read", arguments: {} },
					{ type: "toolCall", id: "grep-1", name: "grep", arguments: {} },
					{ type: "toolCall", id: "grep-2", name: "grep", arguments: {} },
					{ type: "toolCall", id: "grep-3", name: "grep", arguments: {} },
				],
				api: "openai",
				provider: "openai",
				model: "gpt-5",
				usage,
				stopReason: "error",
				errorMessage: "operation aborted by user",
				timestamp: timestamp + 120_000,
				duration: 42,
			},
		},
		{
			type: "message",
			id: "tool-1",
			parentId: "assistant-1",
			timestamp: new Date(timestamp + 180_000).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "edit-1",
				toolName: "edit",
				isError: false,
				content: [{ type: "text", text: "edited" }],
				details: {
					perFileResults: [
						{
							path: "src/a.ts",
							diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line",
						},
						{
							path: "src/deleted.ts",
							diff: "",
							op: "delete",
							oldText: "one\ntwo\n",
						},
						{
							path: "src/renamed.ts",
							diff: "",
							op: "update",
							move: "src/renamed.ts",
							sourcePath: "src/original.ts",
						},
					],
					meta: {
						truncation: { totalBytes: 9000, totalLines: 400, outputBytes: 1000, outputLines: 40 },
					},
				},
			},
		},
		{
			type: "message",
			id: "tool-2",
			parentId: "assistant-1",
			timestamp: new Date(timestamp + 240_000).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "bash-1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "Operation aborted" }],
				details: {},
			},
		},
		{
			type: "message",
			id: "tool-3",
			parentId: "assistant-1",
			timestamp: new Date(timestamp + 300_000).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "bash-2",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "script failed" }],
				details: { reason: "script installed an abort handler" },
			},
		},
		{
			type: "message",
			id: "assistant-2",
			parentId: "tool-3",
			timestamp: new Date(timestamp + 360_000).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "grep-4", name: "grep", arguments: {} }],
				api: "openai",
				provider: "openai",
				model: "gpt-5",
				usage,
				stopReason: "toolUse",
				timestamp: timestamp + 360_000,
				duration: 20,
			},
		},
	];
	const subagentEntry = {
		type: "session_init",
		id: "subagent-1",
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		systemPrompt: "system",
		task: "task",
		tools: [],
	};
	await Bun.write(mainFile, `${mainEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	await Bun.write(subagentFile, `${JSON.stringify(subagentEntry)}\n`);
	return { mainFile, subagentFile };
}

function sumCounters(rows: SessionHealthStats[]) {
	return rows.reduce(
		(acc, row) => {
			acc.retry += row.retryCount;
			acc.loops += row.toolLoopCount;
			acc.cancellations += row.cancellationCount;
			acc.files += row.editFilesChanged;
			acc.added += row.editLinesAdded;
			acc.removed += row.editLinesRemoved;
			acc.compactions += row.compactionCount;
			acc.tokensBefore += row.compactionTokensBefore;
			acc.switches += row.modelSwitchCount;
			acc.subagents += row.subagentSpawnCount;
			acc.large += row.largeResultCount;
			acc.largeBytes += row.largeResultBytes;
			acc.largeLines += row.largeResultLines;
			return acc;
		},
		{
			retry: 0,
			loops: 0,
			cancellations: 0,
			files: 0,
			added: 0,
			removed: 0,
			compactions: 0,
			tokensBefore: 0,
			switches: 0,
			subagents: 0,
			large: 0,
			largeBytes: 0,
			largeLines: 0,
		},
	);
}

describe("session health parser", () => {
	it("extracts retry, loop, cancellation, churn, compaction, model, fanout, and large-result signals", async () => {
		const { mainFile, subagentFile } = await writeHealthSessionFiles();

		const main = await parseSessionFile(mainFile);
		const subagent = await parseSessionFile(subagentFile);
		const rows = [...main.healthStats, ...subagent.healthStats];

		expect(rows.map(row => row.kind).sort()).toEqual([
			"cancellation",
			"cancellation",
			"compaction",
			"edit_churn",
			"large_result",
			"model_switch",
			"retry",
			"subagent_spawn",
			"tool_loop",
			"tool_loop",
			"tool_loop",
		]);
		expect(sumCounters(rows)).toEqual({
			retry: 1,
			loops: 4,
			cancellations: 2,
			files: 3,
			added: 2,
			removed: 3,
			compactions: 1,
			tokensBefore: 1234,
			switches: 1,
			subagents: 1,
			large: 1,
			largeBytes: 9000,
			largeLines: 400,
		});
		expect(rows.find(row => row.kind === "model_switch")).toMatchObject({
			entryId: "model-2",
			provider: "openai",
			model: "gpt-5",
		});
		expect(rows.find(row => row.kind === "edit_churn")).toMatchObject({ toolName: "edit", editFilesChanged: 3 });
	});
});
