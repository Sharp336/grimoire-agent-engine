import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";

const require = createRequire(import.meta.url);
const nativeBindings = require("../../natives/native/index.js") as Record<string, unknown> & {
	ChunkState?: { parse: (source: string, language?: string) => unknown };
	formatAnchor?: (name: string, checksum?: string, style?: string) => string;
	getDefaultTabWidth?: () => number;
	getIndentation?: (file?: string | null, projectDir?: string | null) => number;
	setDefaultTabWidth?: (width: number) => void;
	MacOSPowerAssertion?: { start: (options: { reason: string }) => { stop: () => void } };
};

vi.mock("@oh-my-pi/pi-natives", () => ({
	...nativeBindings,
	ChunkState: nativeBindings.ChunkState ?? {
		parse() {
			throw new Error("ChunkState.parse unavailable in test");
		},
	},
	formatAnchor:
		nativeBindings.formatAnchor ?? ((name: string, checksum?: string) => (checksum ? `${name}#${checksum}` : name)),
	getDefaultTabWidth: nativeBindings.getDefaultTabWidth ?? (() => 4),
	getIndentation: nativeBindings.getIndentation ?? (() => 4),
	setDefaultTabWidth: nativeBindings.setDefaultTabWidth ?? (() => {}),
	MacOSPowerAssertion: nativeBindings.MacOSPowerAssertion ?? { start: () => ({ stop: () => {} }) },
}));

const { Settings } = require("../src/config/settings") as typeof import("../src/config/settings");
const pythonExecutor = require("../src/ipy/executor") as typeof import("../src/ipy/executor");
const pythonKernel = require("../src/ipy/kernel") as typeof import("../src/ipy/kernel");
const { PythonTool } = require("../src/tools/python") as typeof import("../src/tools/python");

function createSession(
	cwd: string,
	sessionFile: string,
	overrides?: Partial<Record<SettingPath, unknown>>,
	kernelOwnerId?: string,
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => null,
		getPythonKernelOwnerId: () => kernelOwnerId ?? null,
		forcePythonWarmup: true,
		settings: Settings.isolated({ "python.toolMode": "ipy-only", ...overrides }),
	};
}

async function loadCreateTools(): Promise<typeof import("../src/tools").createTools> {
	return (await import("../src/tools")).createTools;
}

describe("python tool settings", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `python-tool-settings-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		pythonExecutor.resetPreludeDocsCache();
		vi.restoreAllMocks();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("exposes python tool when kernel is available", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const sessionFile = path.join(testDir, "session.jsonl");
		const createTools = await loadCreateTools();
		const tools = await createTools(createSession(testDir, sessionFile), ["python"]);

		expect(tools.map(tool => tool.name).sort()).toEqual(["exit_plan_mode", "python"]);
	});

	it("falls back to bash when python is unavailable", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({
			ok: false,
			reason: "missing",
		});
		const sessionFile = path.join(testDir, "session.jsonl");
		const createTools = await loadCreateTools();
		const tools = await createTools(createSession(testDir, sessionFile), ["python"]);

		expect(tools.map(tool => tool.name).sort()).toEqual(["bash", "exit_plan_mode"]);
	});

	it("passes kernel owner and kernel mode from settings to executor", async () => {
		vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue([]);
		const warmupSpy = vi.spyOn(pythonExecutor, "warmPythonEnvironment").mockResolvedValue({ ok: true, docs: [] });
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
			displayOutputs: [],
			stdinRequested: false,
		});

		const sessionFile = path.join(testDir, "session.jsonl");
		const kernelOwnerId = "owner-456";
		const session = createSession(testDir, sessionFile, { "python.kernelMode": "per-call" }, kernelOwnerId);
		const pythonTool = new PythonTool(session);

		await pythonTool.execute("tool-call", { cells: [{ code: "print(1)" }] });

		expect(warmupSpy).toHaveBeenCalledWith(
			testDir,
			`session:${sessionFile}:cwd:${testDir}`,
			true,
			sessionFile,
			kernelOwnerId,
		);
		expect(executeSpy).toHaveBeenCalledWith(
			"print(1)",
			expect.objectContaining({
				kernelMode: "per-call",
				sessionId: `session:${sessionFile}:cwd:${testDir}`,
				kernelOwnerId,
			}),
		);
	});

	it("passes kernel owner into createTools warmup without changing session ids", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue([]);
		const warmupSpy = vi.spyOn(pythonExecutor, "warmPythonEnvironment").mockResolvedValue({ ok: true, docs: [] });

		const sessionFile = path.join(testDir, "session-create-tools.jsonl");
		const kernelOwnerId = "owner-create-tools";
		const createTools = await loadCreateTools();
		await createTools(createSession(testDir, sessionFile, undefined, kernelOwnerId), ["python"]);

		expect(warmupSpy).toHaveBeenCalledWith(
			testDir,
			`session:${sessionFile}:cwd:${testDir}`,
			true,
			sessionFile,
			kernelOwnerId,
		);
	});
});
