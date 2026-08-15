import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
const toolName = "mcp__fixture";
const toolArguments = { query: "docs" };
const toolResult = "fixture response";

let tempRoot: TempDir | undefined;

beforeEach(() => {
	tempRoot = TempDir.createSync("@omp-stats-cli-json-");
});

afterEach(async () => {
	await tempRoot?.remove();
	tempRoot = undefined;
});

async function writeSessionFixture(agentDir: string): Promise<void> {
	const timestamp = new Date().toISOString();
	const timestampMs = Date.parse(timestamp);
	const entries = [
		{
			type: "session",
			version: 3,
			id: "stats-cli-fixture",
			timestamp,
			cwd: "/tmp/stats-cli-fixture",
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Using the fixture tool." },
					{ type: "toolCall", id: "call-1", name: toolName, arguments: toolArguments },
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
				},
				stopReason: "toolUse",
				timestamp: timestampMs,
				duration: 10,
				ttft: 5,
			},
		},
		{
			type: "message",
			id: "tool-result-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName,
				content: [{ type: "text", text: toolResult }],
				isError: false,
				timestamp: timestampMs,
			},
		},
	];
	const sessionFile = path.join(agentDir, "sessions", "--tmp--stats-cli-fixture", "session.jsonl");
	await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

async function runStatsJson(agentDir: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const homeDir = path.dirname(path.dirname(agentDir));
	const proc = Bun.spawn([process.execPath, cliEntry, "stats", "-j"], {
		cwd: path.join(import.meta.dir, ".."),
		env: {
			...process.env,
			HOME: homeDir,
			PI_CODING_AGENT_DIR: agentDir,
			XDG_DATA_HOME: path.join(homeDir, "xdg-data"),
			XDG_STATE_HOME: path.join(homeDir, "xdg-state"),
			XDG_CACHE_HOME: path.join(homeDir, "xdg-cache"),
			NO_COLOR: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("stats CLI JSON", () => {
	it("includes all-time tool aggregates without the larger dashboard series", async () => {
		if (!tempRoot) throw new Error("Temporary stats root was not initialized");
		const agentDir = tempRoot.join(".omp", "agent");
		await writeSessionFixture(agentDir);

		const result = await runStatsJson(agentDir);
		expect(result.exitCode).toBe(0);
		const jsonStart = result.stdout.indexOf("{");
		expect(jsonStart).toBeGreaterThanOrEqual(0);
		const payload = JSON.parse(result.stdout.slice(jsonStart));

		expect(payload.overall.totalRequests).toBe(1);
		expect(payload.tooling.byTool).toEqual([
			expect.objectContaining({
				tool: toolName,
				calls: 1,
				errors: 0,
				argsChars: JSON.stringify(toolArguments).length,
				resultChars: toolResult.length,
			}),
		]);
		expect(payload.tooling).not.toHaveProperty("byToolModel");
		expect(payload.tooling).not.toHaveProperty("series");
	});
});
