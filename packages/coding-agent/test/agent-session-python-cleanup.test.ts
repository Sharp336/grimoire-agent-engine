import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/ipy/executor";
import type { PreludeHelper, PythonKernel as PythonKernelInstance } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
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
	abortBlockedExecution = true;

	isAlive(): boolean {
		return this.alive;
	}

	async execute(code: string, options?: { signal?: AbortSignal }): Promise<typeof OK_EXECUTION> {
		this.executeCalls.push(code);
		if (code === this.blockedCode && this.blockedExecution) {
			this.blockedExecutionStarted?.();
			if (!this.abortBlockedExecution || !options?.signal) {
				return await this.blockedExecution;
			}
			return await Promise.race([
				this.blockedExecution,
				new Promise<typeof OK_EXECUTION>((_, reject) => {
					const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
					if (options.signal?.aborted) {
						onAbort();
						return;
					}
					options.signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		}
		return OK_EXECUTION;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}

	shutdown = vi.fn(async () => {
		this.shutdownCalls += 1;
		this.alive = false;
		this.blockedExecutionReject?.(new Error("Kernel shut down during execution"));
		return { confirmed: true };
	});
}

const getModel = () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	return model;
};

const createTempProject = () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-agent-session-python-cleanup-${Snowflake.next()}-`));
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	return { tempDir, cwd };
};

const createSession = async (tempDir: string, cwd: string) =>
	(
		await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "python.kernelMode": "session" }),
			model: getModel(),
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

const stubPythonWarmup = () =>
	vi.spyOn(pythonExecutor, "warmPythonEnvironment").mockResolvedValue({ ok: true, docs: [] });

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
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		pythonExecutor.resetPreludeDocsCache();
		stubPythonWarmup();

		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		let blockedExecutionSettled = false;
		blockedExecution.promise.then(
			() => {
				blockedExecutionSettled = true;
			},
			() => {
				blockedExecutionSettled = true;
			},
		);
		kernel.blockedCode = "print('first')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();
		kernel.blockedExecutionReject = error => blockedExecution.reject(error);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);
		const firstSession = await createSession(tempDir, cwd);
		const secondSession = await createSession(tempDir, cwd);
		expect(startSpy).toHaveBeenCalledTimes(0);
		let firstDisposed = false;

		try {
			const firstExecution = firstSession.executePython("print('first')");
			let firstExecutionSettled = false;
			const observedFirstExecution = firstExecution.finally(() => {
				firstExecutionSettled = true;
			});
			await blockedExecutionStarted.promise;

			const disposeFirst = firstSession.dispose().then(() => {
				expect(blockedExecutionSettled).toBe(true);
				expect(firstExecutionSettled).toBe(true);
				firstDisposed = true;
			});
			await Bun.sleep(0);
			expect(firstDisposed).toBe(false);
			expect(blockedExecutionSettled).toBe(false);
			expect(firstExecutionSettled).toBe(false);

			const secondExecution = secondSession.executePython("print('second')");
			await Bun.sleep(0);

			expect(firstDisposed).toBe(false);
			expect(blockedExecutionSettled).toBe(false);
			expect(firstExecutionSettled).toBe(false);
			expect(kernel.shutdownCalls).toBe(0);

			blockedExecution.resolve(OK_EXECUTION);
			await Promise.all([observedFirstExecution, secondExecution, disposeFirst]);

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

	it("aborts tracked Python tool warmup during session dispose before executePython starts", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		pythonExecutor.resetPreludeDocsCache();

		const blockedWarmupStarted = Promise.withResolvers<void>();
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "tool ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 7,
			outputLines: 1,
			outputBytes: 7,
			displayOutputs: [],
			stdinRequested: false,
		});
		let warmupCallCount = 0;
		const warmupSpy = vi
			.spyOn(pythonExecutor, "warmPythonEnvironment")
			.mockImplementation(async (_cwd, _sessionId, _useSharedGateway, _sessionFile, _kernelOwnerId, signal) => {
				warmupCallCount += 1;
				if (warmupCallCount === 1) {
					return { ok: true, docs: [] };
				}
				blockedWarmupStarted.resolve();
				return await new Promise<{ ok: boolean; reason?: string; docs: [] }>(resolve => {
					const onAbort = () => resolve({ ok: false, reason: "Warmup aborted", docs: [] });
					if (signal?.aborted) {
						onAbort();
						return;
					}
					signal?.addEventListener("abort", onAbort, { once: true });
				});
			});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });

		const session = await createSession(tempDir, cwd);
		const pythonTool = session.getToolByName("python");
		expect(pythonTool).toBeDefined();
		let toolExecutionSettled = false;
		const toolExecution = pythonTool!
			.execute("call-id", { cells: [{ code: "print('tool')" }] }, undefined, undefined, undefined)
			.finally(() => {
				toolExecutionSettled = true;
			});
		await blockedWarmupStarted.promise;

		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(0);

		expect(disposed).toBe(false);
		expect(toolExecutionSettled).toBe(false);
		expect(warmupSpy).toHaveBeenCalledTimes(2);
		expect(executeSpy).not.toHaveBeenCalled();

		await expect(toolExecution).rejects.toThrow("Operation aborted");
		await disposeSession;

		expect(disposed).toBe(true);
		expect(toolExecutionSettled).toBe(true);
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("aborts tracked Python tool execution during session dispose after warmup completes", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		pythonExecutor.resetPreludeDocsCache();

		const helper: PreludeHelper = {
			name: "helper",
			signature: "helper()",
			docstring: "doc",
			category: "general",
		};
		let preludeDocs: PreludeHelper[] = [];
		vi.spyOn(pythonExecutor, "getPreludeDocs").mockImplementation(() => preludeDocs);
		const warmupSpy = vi.spyOn(pythonExecutor, "warmPythonEnvironment").mockImplementation(async () => {
			preludeDocs = [helper];
			return { ok: true, docs: preludeDocs };
		});
		const blockedExecuteStarted = Promise.withResolvers<void>();
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockImplementation(async (_code, options) => {
			const signal = options?.signal;
			if (!signal) {
				throw new Error("Expected abort signal");
			}
			blockedExecuteStarted.resolve();
			return await new Promise(resolve => {
				const onAbort = () =>
					resolve({
						output: "Command aborted",
						exitCode: undefined,
						cancelled: true,
						truncated: false,
						totalLines: 1,
						totalBytes: 15,
						outputLines: 1,
						outputBytes: 15,
						displayOutputs: [],
						stdinRequested: false,
					});
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });

		const session = await createSession(tempDir, cwd);
		const pythonTool = session.getToolByName("python");
		expect(pythonTool).toBeDefined();
		let toolExecutionSettled = false;
		const toolExecution = pythonTool!
			.execute("call-id", { cells: [{ code: "print('tool')" }] }, undefined, undefined, undefined)
			.finally(() => {
				toolExecutionSettled = true;
			});
		await blockedExecuteStarted.promise;

		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(0);

		expect(disposed).toBe(false);
		expect(toolExecutionSettled).toBe(false);
		expect(warmupSpy).toHaveBeenCalledTimes(1);
		expect(executeSpy).toHaveBeenCalledTimes(1);

		const [toolResult] = await Promise.all([toolExecution, disposeSession]);

		expect(disposed).toBe(true);
		expect(toolExecutionSettled).toBe(true);
		expect(warmupSpy).toHaveBeenCalledTimes(1);
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(toolResult.details?.isError).toBe(true);
		expect(toolResult.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("Command aborted") }),
		);
	});

	it("detaches retained kernel ownership even when dispose times out waiting for Python work", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		pythonExecutor.resetPreludeDocsCache();
		stubPythonWarmup();

		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		kernel.blockedCode = "print('blocked')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();
		kernel.abortBlockedExecution = false;

		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const firstSession = await createSession(tempDir, cwd);
		const secondSession = await createSession(tempDir, cwd);

		await secondSession.executePython("print('owner-b warmup')");
		const firstExecution = firstSession.executePython("print('blocked')");
		await blockedExecutionStarted.promise;
		let firstExecutionSettled = false;
		void firstExecution.finally(() => {
			firstExecutionSettled = true;
		});

		let firstDisposed = false;
		const disposeFirst = firstSession.dispose().then(() => {
			firstDisposed = true;
		});
		await disposeFirst;

		expect(firstDisposed).toBe(true);
		expect(firstExecutionSettled).toBe(false);
		expect(kernel.shutdownCalls).toBe(0);
		expect(startSpy).toHaveBeenCalledTimes(1);

		blockedExecution.resolve(OK_EXECUTION);
		await expect(firstExecution).resolves.toMatchObject({
			cancelled: false,
			exitCode: 0,
			stdinRequested: false,
		});
		await secondSession.executePython("print('owner-b after detach')");
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.executeCalls).toEqual([
			"print('owner-b warmup')",
			"print('blocked')",
			"print('owner-b after detach')",
		]);
		await secondSession.dispose();

		expect(kernel.shutdownCalls).toBe(1);
	}, 10000);

	it("aborts every active Python execution owned by the session during dispose", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		pythonExecutor.resetPreludeDocsCache();
		stubPythonWarmup();

		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		kernel.blockedCode = "print('first')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();

		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const session = await createSession(tempDir, cwd);

		const firstExecution = session.executePython("print('first')");
		await blockedExecutionStarted.promise;
		const secondExecution = session.executePython("print('second')");
		await Bun.sleep(0);

		await session.dispose();
		const [firstResult, secondResult] = await Promise.all([firstExecution, secondExecution]);

		expect(firstResult.cancelled).toBe(true);
		expect(secondResult.cancelled).toBe(true);
		expect(kernel.executeCalls).toEqual(["print('first')"]);
		expect(kernel.shutdownCalls).toBe(1);
	});
});
