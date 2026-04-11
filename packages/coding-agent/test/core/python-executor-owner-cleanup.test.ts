import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
	resetPreludeDocsCache,
	warmPythonEnvironment,
} from "@oh-my-pi/pi-coding-agent/ipy/executor";
import * as gatewayCoordinator from "@oh-my-pi/pi-coding-agent/ipy/gateway-coordinator";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PreludeHelper,
	PythonKernel as PythonKernelInstance,
} from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

class FakeKernel {
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true }));
	ping = vi.fn(async () => true);
	alive = true;

	isAlive(): boolean {
		return this.alive;
	}
}

afterEach(async () => {
	await disposeAllKernelSessions();
	resetPreludeDocsCache();
	vi.restoreAllMocks();
});

describe("python executor owner cleanup", () => {
	it("keeps shared retained kernels alive until the last owner is disposed", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("2 + 2", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernel.shutdown).not.toHaveBeenCalled();

		await executePython("3 + 3", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-b");

		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("disposes every retained kernel owned by one owner across session ids and cwd values", async () => {
		const kernelOne = new FakeKernel();
		const kernelTwo = new FakeKernel();
		const unrelatedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(kernelOne as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(kernelTwo as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);

		await executePython("print('one')", {
			cwd: "/tmp/owner-a-one",
			sessionId: "session-one",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('two')", {
			cwd: "/tmp/owner-a-two",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('other')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernelOne.shutdown).toHaveBeenCalledTimes(1);
		expect(kernelTwo.shutdown).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		await executePython("print('still alive')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("does not reattach a kernel after owner disposal has already claimed it", async () => {
		const disposingKernel = new FakeKernel();
		const replacementKernel = new FakeKernel();
		const shutdownDeferred = Promise.withResolvers<KernelShutdownResult>();
		disposingKernel.shutdown = vi.fn(() => shutdownDeferred.promise);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(disposingKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});

		const disposal = disposeKernelSessionsByOwner("owner-a");
		await executePython("2 + 2", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(disposingKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(disposingKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(replacementKernel.shutdown).not.toHaveBeenCalled();

		shutdownDeferred.resolve({ confirmed: true });
		await disposal;

		await disposeKernelSessionsByOwner("owner-b");
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("keeps tracked disposals counted against retained kernel capacity until shutdown settles", async () => {
		const retainedKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel(), new FakeKernel()];
		const replacementKernel = new FakeKernel();
		const shutdownDeferreds = retainedKernels.map(() => Promise.withResolvers<KernelShutdownResult>());
		for (const [index, kernel] of retainedKernels.entries()) {
			kernel.shutdown = vi.fn(() => shutdownDeferreds[index]!.promise);
		}
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start");
		for (const kernel of [...retainedKernels, replacementKernel]) {
			startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
		}

		for (const [index] of retainedKernels.entries()) {
			await executePython(`print(${index})`, {
				cwd: `/tmp/capacity-tracking-${index}`,
				sessionId: `capacity-session-${index}`,
				kernelMode: "session",
			});
		}
		expect(startSpy).toHaveBeenCalledTimes(4);

		const globalDisposal = disposeAllKernelSessions();
		await Promise.resolve();

		const fifthExecution = executePython("print('replacement')", {
			cwd: "/tmp/capacity-tracking-replacement",
			sessionId: "capacity-session-replacement",
			kernelMode: "session",
		});
		await Promise.resolve();

		expect(startSpy).toHaveBeenCalledTimes(4);
		expect(replacementKernel.execute).not.toHaveBeenCalled();

		shutdownDeferreds[0]!.resolve({ confirmed: true });
		await fifthExecution;
		expect(startSpy).toHaveBeenCalledTimes(5);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

		for (const deferred of shutdownDeferreds.slice(1)) {
			deferred.resolve({ confirmed: true });
		}
		await globalDisposal;
		await disposeAllKernelSessions();
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("clears stuck tracked disposals during resource-exhaustion recovery", async () => {
		vi.useFakeTimers();
		try {
			const staleKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel()];
			const recoveredKernel = new FakeKernel();
			const laterKernel = new FakeKernel();
			const staleShutdownDeferreds = staleKernels.map(() => Promise.withResolvers<KernelShutdownResult>());
			for (const [index, kernel] of staleKernels.entries()) {
				kernel.shutdown = vi.fn(() => staleShutdownDeferreds[index]!.promise);
			}
			const shutdownSharedGatewaySpy = vi.spyOn(gatewayCoordinator, "shutdownSharedGateway").mockResolvedValue();
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			const startSpy = vi.spyOn(PythonKernel, "start");
			for (const kernel of staleKernels) {
				startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
			}
			startSpy
				.mockRejectedValueOnce(new Error("EMFILE: too many open files"))
				.mockResolvedValueOnce(recoveredKernel as unknown as PythonKernelInstance)
				.mockResolvedValueOnce(laterKernel as unknown as PythonKernelInstance);

			for (const [index] of staleKernels.entries()) {
				await executePython(`print(${index})`, {
					cwd: `/tmp/recovery-stale-${index}`,
					sessionId: `recovery-stale-session-${index}`,
					kernelMode: "session",
					kernelOwnerId: "owner-a",
				});
			}

			const ownerCleanup = disposeKernelSessionsByOwner("owner-a");
			await Promise.resolve();
			for (const kernel of staleKernels) {
				expect(kernel.shutdown).toHaveBeenCalledWith({ timeoutMs: 2_000 });
			}
			vi.advanceTimersByTime(2_000);
			await ownerCleanup;

			await executePython("print('recovered')", {
				cwd: "/tmp/recovery-after-emfile",
				sessionId: "recovery-session",
				kernelMode: "session",
			});
			expect(shutdownSharedGatewaySpy).toHaveBeenCalledTimes(1);
			expect(startSpy).toHaveBeenCalledTimes(5);
			expect(recoveredKernel.execute).toHaveBeenCalledTimes(1);

			await executePython("print('later')", {
				cwd: "/tmp/recovery-after-emfile-later",
				sessionId: "recovery-session-later",
				kernelMode: "session",
				deadlineMs: Date.now() + 50,
			});
			expect(startSpy).toHaveBeenCalledTimes(6);
			expect(recoveredKernel.shutdown).not.toHaveBeenCalled();
			expect(laterKernel.execute).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns owner cleanup promptly but keeps retained capacity reserved until shutdown is confirmed", async () => {
		vi.useFakeTimers();
		try {
			const retainedKernels = [new FakeKernel(), new FakeKernel(), new FakeKernel(), new FakeKernel()];
			const replacementKernel = new FakeKernel();
			const shutdownDeferreds = retainedKernels.map(() => Promise.withResolvers<KernelShutdownResult>());
			for (const [index, kernel] of retainedKernels.entries()) {
				kernel.shutdown = vi.fn(() => shutdownDeferreds[index]!.promise);
			}
			vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
			const startSpy = vi.spyOn(PythonKernel, "start");
			for (const kernel of [...retainedKernels, replacementKernel]) {
				startSpy.mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
			}

			for (const [index] of retainedKernels.entries()) {
				await executePython(`print(${index})`, {
					cwd: `/tmp/owner-timeout-kernel-${index}`,
					sessionId: `timeout-session-${index}`,
					kernelMode: "session",
					kernelOwnerId: "owner-a",
				});
			}

			let ownerCleanupResolved = false;
			const ownerCleanup = disposeKernelSessionsByOwner("owner-a").then(() => {
				ownerCleanupResolved = true;
			});
			await Promise.resolve();

			for (const kernel of retainedKernels) {
				expect(kernel.shutdown).toHaveBeenCalledWith({ timeoutMs: 2_000 });
			}
			expect(ownerCleanupResolved).toBe(false);

			vi.advanceTimersByTime(2_000);
			await ownerCleanup;
			expect(ownerCleanupResolved).toBe(true);

			const blockedExecution = executePython("print('replacement')", {
				cwd: "/tmp/owner-timeout-kernel-replacement",
				sessionId: "timeout-session-replacement",
				kernelMode: "session",
				kernelOwnerId: "owner-b",
			});
			await Promise.resolve();

			expect(startSpy).toHaveBeenCalledTimes(4);
			expect(replacementKernel.execute).not.toHaveBeenCalled();

			shutdownDeferreds[0]!.resolve({ confirmed: true });
			await blockedExecution;
			expect(startSpy).toHaveBeenCalledTimes(5);
			expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

			for (const deferred of shutdownDeferreds.slice(1)) {
				deferred.resolve({ confirmed: true });
			}
			await Promise.resolve();
			await disposeAllKernelSessions();
			expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let stuck retained executions block owner or global cleanup", async () => {
		const ownerKernel = new FakeKernel();
		const globalKernel = new FakeKernel();
		const ownerExecutionStarted = Promise.withResolvers<void>();
		const globalExecutionStarted = Promise.withResolvers<void>();
		ownerKernel.execute = vi.fn(async () => {
			ownerExecutionStarted.resolve();
			return await new Promise<KernelExecuteResult>(() => {});
		});
		globalKernel.execute = vi.fn(async () => {
			globalExecutionStarted.resolve();
			return await new Promise<KernelExecuteResult>(() => {});
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(ownerKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(globalKernel as unknown as PythonKernelInstance);

		void executePython("print('owner hangs')", {
			cwd: "/tmp/stuck-owner-cleanup",
			sessionId: "stuck-owner-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await ownerExecutionStarted.promise;

		void executePython("print('global hangs')", {
			cwd: "/tmp/stuck-global-cleanup",
			sessionId: "stuck-global-session",
			kernelMode: "session",
		});
		await globalExecutionStarted.promise;

		const ownerCleanup = Promise.race([
			disposeKernelSessionsByOwner("owner-a").then(() => "disposed-owner" as const),
			new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 50)),
		]);
		await expect(ownerCleanup).resolves.toBe("disposed-owner");
		expect(ownerKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(globalKernel.shutdown).not.toHaveBeenCalled();

		const globalCleanup = Promise.race([
			disposeAllKernelSessions().then(() => "disposed-all" as const),
			new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 50)),
		]);
		await expect(globalCleanup).resolves.toBe("disposed-all");
		expect(globalKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("attaches cached warmup sessions to newly provided owners", async () => {
		using tempDir = TempDir.createSync("@python-owner-warmup-");
		const docs: PreludeHelper[] = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const kernel = {
			introspectPrelude: vi.fn().mockResolvedValue(docs),
			execute: vi.fn(async () => OK_RESULT),
			ping: vi.fn(async () => true),
			isAlive: () => true,
			shutdown: vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true })),
		};
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const firstWarmup = await warmPythonEnvironment(tempDir.path(), "warm-session", true, undefined, "owner-a");
		expect(firstWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);

		const cachedWarmup = await warmPythonEnvironment(tempDir.path(), "warm-session", true, undefined, "owner-b");
		expect(cachedWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");
		expect(kernel.shutdown).not.toHaveBeenCalled();

		await executePython("1 + 1", {
			cwd: tempDir.path(),
			sessionId: "warm-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-b");
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("leaves per-call kernels out of owner-scoped retained cleanup and keeps global cleanup intact", async () => {
		const perCallKernel = new FakeKernel();
		const retainedKernel = new FakeKernel();
		const unownedRetainedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(perCallKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(retainedKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unownedRetainedKernel as unknown as PythonKernelInstance);

		await executePython("print('per-call')", {
			cwd: "/tmp/per-call-owner",
			kernelMode: "per-call",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('retained')", {
			cwd: "/tmp/retained-owner",
			sessionId: "retained-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('unowned')", {
			cwd: "/tmp/unowned-retained",
			sessionId: "unowned-session",
			kernelMode: "session",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");

		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(retainedKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(unownedRetainedKernel.shutdown).not.toHaveBeenCalled();

		await disposeAllKernelSessions();

		expect(unownedRetainedKernel.shutdown).toHaveBeenCalledTimes(1);
	});
});
