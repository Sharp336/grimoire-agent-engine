import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { BashRunner, type BashRunnerHost } from "@oh-my-pi/pi-coding-agent/session/bash-runner";
import { type MinimizedSaveHandlerSession, makeMinimizedSaveHandler } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { appendBashMinimizerGainRecord } from "@oh-my-pi/pi-coding-agent/tools/bash-minimizer-gain";

function gainPath(agentDir: string): string {
	return path.join(agentDir, "minimizer-gain.jsonl");
}

interface GainRecord {
	timestamp: string;
	cwd?: string;
	sessionCwd?: string;
	sessionId?: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	exitCode: number | null;
	kind: "saved" | "missed";
}

describe("bash minimizer gain writer", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gain-writer-"));
		agentDir = path.join(tempDir, "agent");
		cwd = path.join(tempDir, "repo");
		await fs.mkdir(cwd);
		await fs.mkdir(path.join(tempDir, "session"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function records(): Promise<GainRecord[]> {
		const text = await Bun.file(gainPath(agentDir)).text();
		return text
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as GainRecord);
	}

	test("writes a saved record with the completed command outcome", async () => {
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "bun test noisy.test.ts",
			cwd,
			sessionCwd: path.join(tempDir, "session"),
			sessionId: "session-test-id",
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
			exitCode: 1,
		});

		const [record] = await records();
		expect(record).toEqual(
			expect.objectContaining({
				command: "bun test noisy.test.ts",
				cwd: await fs.realpath(cwd),
				sessionCwd: await fs.realpath(path.join(tempDir, "session")),
				sessionId: "session-test-id",
				filter: "bun-test",
				inputBytes: 4000,
				outputBytes: 1000,
				savedBytes: 3000,
				savedTokens: 750,
				exitCode: 1,
				kind: "saved",
			}),
		);
		expect(Number.isFinite(Date.parse(record!.timestamp))).toBe(true);
	});

	test("skips non-saving and empty missed records", async () => {
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "echo short",
			cwd,
			filter: "noop",
			inputBytes: 10,
			outputBytes: 10,
			exitCode: 0,
		});
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "true",
			cwd,
			filter: "missed",
			inputBytes: 0,
			outputBytes: 0,
			exitCode: 0,
			kind: "missed",
		});

		expect(await Bun.file(gainPath(agentDir)).exists()).toBe(false);
	});

	test("writes eligible unchanged output as a missed record", async () => {
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "git status",
			cwd,
			filter: "missed",
			inputBytes: 200,
			outputBytes: 200,
			exitCode: 0,
			kind: "missed",
		});

		const [record] = await records();
		expect(record).toEqual(
			expect.objectContaining({
				filter: "missed",
				inputBytes: 200,
				outputBytes: 200,
				savedBytes: 0,
				kind: "missed",
			}),
		);
		expect(record!.savedTokens).toBeUndefined();
	});

	test("creates the telemetry file 0600 and its directory 0700 even under a permissive umask", async () => {
		if (process.platform === "win32") return;

		const previousUmask = process.umask(0);
		try {
			await appendBashMinimizerGainRecord({
				agentDir,
				command: "git status",
				cwd,
				filter: "missed",
				inputBytes: 200,
				outputBytes: 200,
				exitCode: 0,
				kind: "missed",
			});
		} finally {
			process.umask(previousUmask);
		}

		const fileStat = await fs.stat(gainPath(agentDir));
		const dirStat = await fs.stat(agentDir);
		expect(fileStat.mode & 0o777).toBe(0o600);
		expect(dirStat.mode & 0o777).toBe(0o700);
	});

	test("tightens an existing world-readable telemetry file to 0600", async () => {
		if (process.platform === "win32") return;

		await fs.mkdir(agentDir, { recursive: true, mode: 0o755 });
		await fs.writeFile(gainPath(agentDir), "", { mode: 0o644 });
		await fs.chmod(gainPath(agentDir), 0o644);
		await fs.chmod(agentDir, 0o755);

		await appendBashMinimizerGainRecord({
			agentDir,
			command: "git status",
			cwd,
			filter: "missed",
			inputBytes: 200,
			outputBytes: 200,
			exitCode: 0,
			kind: "missed",
		});

		expect((await fs.stat(gainPath(agentDir))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(agentDir)).mode & 0o777).toBe(0o700);
	});
});

describe("makeMinimizedSaveHandler", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gain-handler-"));
		agentDir = path.join(tempDir, "agent");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function mockSession(gainTelemetry: boolean, prefix?: string): MinimizedSaveHandlerSession {
		return {
			cwd: tempDir,
			getSessionId: () => "test-session",
			settings: {
				get: () => gainTelemetry,
				getAgentDir: () => agentDir,
				getShellConfig: () => ({ prefix }),
			},
		};
	}

	test("flushes saved telemetry after the real exit code is available", async () => {
		const handler = makeMinimizedSaveHandler(mockSession(true), "bun test noisy.test.ts", tempDir);
		await handler.onMinimizedSave("original output", { filter: "bun-test", inputBytes: 4000, outputBytes: 1000 });
		await handler.flushSaved(1, 1000);

		const [line] = (await Bun.file(gainPath(agentDir)).text()).trim().split("\n");
		const record = JSON.parse(line!) as GainRecord;
		expect(handler.didSave()).toBe(true);
		expect(record).toEqual(expect.objectContaining({ kind: "saved", filter: "bun-test", exitCode: 1 }));
	});

	test("records final output bytes including a successful raw-output artifact footer", async () => {
		const handler = makeMinimizedSaveHandler(mockSession(true), "bun test noisy.test.ts", tempDir);
		const visibleOutput = "minimized result\n[raw output: artifact://artifact-42]\n";
		await handler.onMinimizedSave("original output", { filter: "bun-test", inputBytes: 4000, outputBytes: 17 });
		await handler.flushSaved(0, Buffer.byteLength(visibleOutput));

		const [line] = (await Bun.file(gainPath(agentDir)).text()).trim().split("\n");
		const record = JSON.parse(line!) as GainRecord;
		expect(record).toEqual(
			expect.objectContaining({
				kind: "saved",
				exitCode: 0,
				outputBytes: Buffer.byteLength(visibleOutput),
				savedBytes: 4000 - Buffer.byteLength(visibleOutput),
			}),
		);
	});

	test("suppresses saved telemetry when disabled or prefixed", async () => {
		for (const session of [mockSession(false), mockSession(true, "time")]) {
			const handler = makeMinimizedSaveHandler(session, "git status", tempDir);
			await handler.onMinimizedSave("status output", { filter: "git", inputBytes: 2000, outputBytes: 500 });
			await handler.flushSaved(0, 500);
		}

		expect(await Bun.file(gainPath(agentDir)).exists()).toBe(false);
	});
});

describe("BashRunner gain telemetry", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gain-runner-"));
		agentDir = path.join(tempDir, "agent");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("records the completed output including its raw-output artifact footer", async () => {
		const rawArtifactId = "artifact-42";
		const visibleOutput = `minimized result\n[raw output: artifact://${rawArtifactId}]\n`;
		const execute = vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			const artifactId = await options?.onMinimizedSave?.("original output", {
				filter: "bun-test",
				inputBytes: 4000,
				outputBytes: 17,
			});
			expect(artifactId).toBe(rawArtifactId);
			return {
				output: visibleOutput,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 2,
				totalBytes: Buffer.byteLength(visibleOutput),
				outputLines: 2,
				outputBytes: Buffer.byteLength(visibleOutput),
			} satisfies BashResult;
		});
		const runner = new BashRunner({
			agent: { appendMessage: vi.fn() },
			sessionManager: {
				getSessionId: () => "test-session",
				getCwd: () => tempDir,
				appendMessage: vi.fn(),
				saveArtifact: async () => rawArtifactId,
			},
			settings: {
				get: (key: string) =>
					key === "shellMinimizer.gainTelemetry" || key === "shellMinimizer.enabled"
						? true
						: key === "tools.maxTimeout"
							? 300
							: undefined,
				getShellConfig: () => ({}),
				getAgentDir: () => agentDir,
			},
			extensionRunner: () => undefined,
			isStreaming: () => false,
		} as unknown as BashRunnerHost);

		await runner.executeBash("bun test noisy.test.ts");

		expect(execute).toHaveBeenCalledTimes(1);
		const [line] = (await Bun.file(gainPath(agentDir)).text()).trim().split("\n");
		expect(JSON.parse(line!)).toEqual(
			expect.objectContaining({
				outputBytes: Buffer.byteLength(visibleOutput),
				savedBytes: 4000 - Buffer.byteLength(visibleOutput),
				sessionCwd: await fs.realpath(tempDir),
			}),
		);
	});

	test("records full minimized output when the sink truncates the inline body", async () => {
		const fullMinimized = "x".repeat(100_000);
		const inline = fullMinimized.slice(0, 50);
		const execute = vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			await options?.onMinimizedSave?.("original output", {
				filter: "bun-test",
				inputBytes: 1_000_000,
				outputBytes: Buffer.byteLength(fullMinimized),
			});
			return {
				output: inline,
				exitCode: 0,
				cancelled: false,
				truncated: true,
				totalLines: 1,
				totalBytes: Buffer.byteLength(fullMinimized),
				outputLines: 1,
				outputBytes: Buffer.byteLength(inline),
			} satisfies BashResult;
		});
		const runner = new BashRunner({
			agent: { appendMessage: vi.fn() },
			sessionManager: {
				getSessionId: () => "test-session",
				getCwd: () => tempDir,
				appendMessage: vi.fn(),
				saveArtifact: async () => "artifact-42",
			},
			settings: {
				get: (key: string) =>
					key === "shellMinimizer.gainTelemetry" || key === "shellMinimizer.enabled"
						? true
						: key === "tools.maxTimeout"
							? 300
							: undefined,
				getShellConfig: () => ({}),
				getAgentDir: () => agentDir,
			},
			extensionRunner: () => undefined,
			isStreaming: () => false,
		} as unknown as BashRunnerHost);

		await runner.executeBash("bun test noisy.test.ts");

		expect(execute).toHaveBeenCalledTimes(1);
		const [line] = (await Bun.file(gainPath(agentDir)).text()).trim().split("\n");
		expect(JSON.parse(line!)).toEqual(
			expect.objectContaining({
				outputBytes: Buffer.byteLength(fullMinimized),
				savedBytes: 1_000_000 - Buffer.byteLength(fullMinimized),
			}),
		);
	});
	test("does not record below-threshold output as a missed gain", async () => {
		const execute = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "short status",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 12,
			outputLines: 1,
			outputBytes: 12,
			minimizerEligible: false,
		} satisfies BashResult);
		const runner = new BashRunner({
			agent: { appendMessage: vi.fn() },
			sessionManager: {
				getSessionId: () => "test-session",
				getCwd: () => tempDir,
				appendMessage: vi.fn(),
			},
			settings: {
				get: (key: string) =>
					key === "shellMinimizer.gainTelemetry" || key === "shellMinimizer.enabled"
						? true
						: key === "tools.maxTimeout"
							? 300
							: undefined,
				getShellConfig: () => ({}),
				getAgentDir: () => agentDir,
			},
			extensionRunner: () => undefined,
			isStreaming: () => false,
		} as unknown as BashRunnerHost);

		await runner.executeBash("git status");

		expect(execute).toHaveBeenCalledTimes(1);
		expect(await Bun.file(gainPath(agentDir)).exists()).toBe(false);
	});
});
