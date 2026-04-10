import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/ipy/executor";
import type { PythonKernel as PythonKernelInstance } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

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
