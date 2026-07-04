import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	disposeAllJuliaKernelSessions,
	disposeJuliaKernelSessionsByOwner,
	executeJulia,
} from "@oh-my-pi/pi-coding-agent/eval/jl/executor";
import { JuliaKernel } from "@oh-my-pi/pi-coding-agent/eval/jl/kernel";
import type { KernelExecuteResult, KernelShutdownResult } from "@oh-my-pi/pi-coding-agent/eval/kernel-base";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

type FakeKernelShutdownOptions = { timeoutMs?: number };

class FakeJuliaKernel {
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(
		async (_options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => ({ confirmed: true }),
	);
	ping = vi.fn(async () => true);
	alive = true;

	isAlive = () => this.alive;
}

async function flushMicrotasks(turns = 6): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await Promise.resolve();
	}
}

describe("Julia executor lifecycle", () => {
	const originalStart = JuliaKernel.start;
	let startCalls = 0;
	let kernels: FakeJuliaKernel[] = [];

	beforeEach(() => {
		startCalls = 0;
		kernels = [];
		JuliaKernel.start = async () => {
			startCalls += 1;
			const fake = new FakeJuliaKernel();
			kernels.push(fake);
			// Deliberate test seam: the lifecycle tests only need the kernel lifecycle surface.
			return fake as unknown as JuliaKernel;
		};
	});

	afterEach(async () => {
		await disposeAllJuliaKernelSessions();
		JuliaKernel.start = originalStart;
		vi.restoreAllMocks();
	});

	it("reuses the same kernel for the same sessionId and cwd", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a" });
		await executeJulia("println(2)", { sessionId: "s1", cwd: "/tmp/a" });

		expect(startCalls).toBe(1);
		expect(kernels[0].execute).toHaveBeenCalledTimes(2);
	});

	it("keeps shared retained kernels alive until the last owner is disposed", async () => {
		await executeJulia("println(1)", {
			sessionId: "s1",
			cwd: "/tmp/a",
			kernelOwnerId: "owner-a",
		});
		await executeJulia("println(2)", {
			sessionId: "s1",
			cwd: "/tmp/a",
			kernelOwnerId: "owner-b",
		});

		expect(startCalls).toBe(1);

		await disposeJuliaKernelSessionsByOwner("owner-a");
		expect(kernels[0].shutdown).not.toHaveBeenCalled();

		await disposeJuliaKernelSessionsByOwner("owner-b");
		expect(kernels[0].shutdown).toHaveBeenCalledTimes(1);
	});

	it("disposes every retained kernel owned by one owner across session ids and cwd values", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a", kernelOwnerId: "owner-a" });
		await executeJulia("println(2)", { sessionId: "s2", cwd: "/tmp/b", kernelOwnerId: "owner-a" });
		await executeJulia("println(3)", { sessionId: "s1", cwd: "/tmp/c", kernelOwnerId: "owner-b" });

		expect(startCalls).toBe(3);

		await disposeJuliaKernelSessionsByOwner("owner-a");

		expect(kernels[0].shutdown).toHaveBeenCalledTimes(1);
		expect(kernels[1].shutdown).toHaveBeenCalledTimes(1);
		expect(kernels[2].shutdown).not.toHaveBeenCalled();
	});

	it("falls back to the retained session id when no explicit owner id is provided during execution", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a" });
		await disposeJuliaKernelSessionsByOwner("s1");
		expect(kernels[0].shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not reattach a kernel after owner disposal has already claimed it", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a", kernelOwnerId: "owner-a" });

		const firstKernel = kernels[0];
		let finishShutdown: () => void = () => {};
		firstKernel.shutdown.mockImplementationOnce(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			finishShutdown = resolve;
			await promise;
			return { confirmed: true };
		});

		const disposePromise = disposeJuliaKernelSessionsByOwner("owner-a");
		await flushMicrotasks();

		const secondExecutePromise = executeJulia("println(2)", {
			sessionId: "s1",
			cwd: "/tmp/a",
			kernelOwnerId: "owner-b",
		});
		await flushMicrotasks();

		expect(startCalls).toBe(2);
		const replacementKernel = kernels[1];
		expect(replacementKernel).not.toBe(firstKernel);

		finishShutdown();
		await disposePromise;

		await secondExecutePromise;
		await disposeJuliaKernelSessionsByOwner("owner-b");
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("retains sessions whose kernel shutdown is not confirmed so a later dispose retries", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a", kernelOwnerId: "owner-a" });

		kernels[0].shutdown.mockImplementationOnce(async () => ({ confirmed: false }));

		await disposeAllJuliaKernelSessions();
		expect(kernels[0].shutdown).toHaveBeenCalledTimes(1);

		await executeJulia("println(2)", { sessionId: "s1", cwd: "/tmp/a", kernelOwnerId: "owner-b" });
		expect(startCalls).toBe(1);
		expect(kernels[0].execute).toHaveBeenCalledTimes(2);

		await disposeAllJuliaKernelSessions();
		expect(kernels[0].shutdown).toHaveBeenCalledTimes(2);
	});

	it("retains owner mapping when owner-scoped shutdown is not confirmed", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a", kernelOwnerId: "owner-a" });

		kernels[0].shutdown.mockImplementationOnce(async () => ({ confirmed: false }));

		await disposeJuliaKernelSessionsByOwner("owner-a");
		expect(kernels[0].shutdown).toHaveBeenCalledTimes(1);

		kernels[0].shutdown.mockImplementationOnce(async () => ({ confirmed: true }));

		await disposeJuliaKernelSessionsByOwner("owner-a");
		expect(kernels[0].shutdown).toHaveBeenCalledTimes(2);
	});

	it("coalesces concurrent reset requests into a single replacement", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a" });

		const firstKernel = kernels[0];

		const ex1 = executeJulia("println(2)", { sessionId: "s1", cwd: "/tmp/a", reset: true });
		const ex2 = executeJulia("println(3)", { sessionId: "s1", cwd: "/tmp/a", reset: true });
		await Promise.all([ex1, ex2]);

		expect(firstKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(startCalls).toBe(2);
		expect(kernels[1].execute).toHaveBeenCalledTimes(2);
	});

	it("replaces dead kernels transparently on the next execute", async () => {
		await executeJulia("println(1)", { sessionId: "s1", cwd: "/tmp/a" });

		kernels[0].alive = false;

		await executeJulia("println(2)", { sessionId: "s1", cwd: "/tmp/a" });

		expect(startCalls).toBe(2);
		expect(kernels[1].execute).toHaveBeenCalledTimes(1);
	});
});
