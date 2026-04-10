import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import type { PythonKernel as PythonKernelInstance } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
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

const OK_EXECUTION = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false } as const;

class FakeKernel {
	executeCalls: string[] = [];
	shutdownCalls = 0;
	alive = true;
	blockedCode: string | undefined;
	blockedExecution: Promise<typeof OK_EXECUTION> | undefined;
	blockedExecutionStarted: (() => void) | undefined;
	blockedExecutionReject: ((error: Error) => void) | undefined;

	isAlive(): boolean {
		return this.alive;
	}

	async execute(code: string): Promise<typeof OK_EXECUTION> {
		this.executeCalls.push(code);
		if (code === this.blockedCode && this.blockedExecution) {
			this.blockedExecutionStarted?.();
			return await this.blockedExecution;
		}
		return OK_EXECUTION;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}

	async shutdown(): Promise<void> {
		this.shutdownCalls += 1;
		this.alive = false;
		this.blockedExecutionReject?.(new Error("Kernel shut down during execution"));
	}
}

async function loadSdkModules(): Promise<{
	createAgentSession: typeof import("../src/sdk").createAgentSession;
	SessionManager: typeof import("../src/session/session-manager").SessionManager;
}> {
	const [{ createAgentSession }, { SessionManager }] = await Promise.all([
		import("../src/sdk"),
		import("../src/session/session-manager"),
	]);
	return { createAgentSession, SessionManager };
}

describe("AgentSession python cleanup", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		pythonExecutor.resetPreludeDocsCache();
		vi.restoreAllMocks();
		await pythonExecutor.disposeAllKernelSessions();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("waits for active SDK session Python work before releasing a shared retained kernel", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-agent-session-python-cleanup-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });

		pythonExecutor.resetPreludeDocsCache();

		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		kernel.blockedCode = "print('first')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();
		kernel.blockedExecutionReject = error => blockedExecution.reject(error);

		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const { createAgentSession, SessionManager } = await loadSdkModules();
		const createSession = async () =>
			(
				await createAgentSession({
					cwd,
					agentDir: tempDir,
					sessionManager: SessionManager.inMemory(cwd),
					settings: Settings.isolated({ "python.kernelMode": "session" }),
					model,
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					forcePythonWarmup: true,
					toolNames: ["python"],
				})
			).session;

		const firstSession = await createSession();
		const secondSession = await createSession();
		expect(startSpy).toHaveBeenCalledTimes(1);
		let firstDisposed = false;

		try {
			const firstExecution = firstSession.executePython("print('first')");
			await blockedExecutionStarted.promise;

			const disposeFirst = firstSession.dispose().then(() => {
				firstDisposed = true;
			});
			await Bun.sleep(0);

			const secondExecution = secondSession.executePython("print('second')");
			await Bun.sleep(0);

			expect(kernel.shutdownCalls).toBe(0);

			blockedExecution.resolve(OK_EXECUTION);
			await firstExecution;
			await disposeFirst;
			await secondExecution;

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.shutdownCalls).toBe(0);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')"]);

			await secondSession.executePython("print('third')");

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')", "print('third')"]);
		} finally {
			if (!firstDisposed) {
				await firstSession.dispose();
			}
			await secondSession.dispose();
		}

		expect(kernel.shutdownCalls).toBe(1);
	});
});
