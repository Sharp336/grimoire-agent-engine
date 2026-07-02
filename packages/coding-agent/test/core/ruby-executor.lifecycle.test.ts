import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	disposeAllRubyKernelSessions,
	disposeRubyKernelSessionsByOwner,
	executeRuby,
} from "@oh-my-pi/pi-coding-agent/eval/rb/executor";
import type { KernelExecuteResult, KernelShutdownResult } from "@oh-my-pi/pi-coding-agent/eval/rb/kernel";
import { RubyKernel } from "@oh-my-pi/pi-coding-agent/eval/rb/kernel";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

type FakeKernelShutdownOptions = { timeoutMs?: number };

class FakeKernel {
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(
		async (_options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => ({ confirmed: true }),
	);
	ping = vi.fn(async () => true);
	alive = true;
	isAlive = vi.fn(() => this.alive);
}

async function flushMicrotasks(turns = 6): Promise<void> {
	let current = 0;
	while (current < turns) {
		await Promise.resolve();
		current += 1;
	}
}

describe("ruby executor owner cleanup", () => {
	const originalStart = RubyKernel.start;
	let startCalls = 0;
	let kernels: FakeKernel[] = [];

	beforeEach(() => {
		startCalls = 0;
		kernels = [];
		RubyKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeKernel();
			kernels.push(kernel);
			// Use a local cast (allowed exception) to mock the kernel creation for the lifecycle tests,
			// as we only need the FakeKernel interface internally.
			return kernel as unknown as RubyKernel;
		}) as typeof RubyKernel.start;
	});

	afterEach(async () => {
		RubyKernel.start = originalStart;
		await disposeAllRubyKernelSessions();
		vi.restoreAllMocks();
	});

	it("reuses kernels for the same sessionId and cwd", async () => {
		await executeRuby("puts 1", { cwd: "/tmp/session-reuse", sessionId: "reuse-session" });
		await executeRuby("puts 2", { cwd: "/tmp/session-reuse", sessionId: "reuse-session" });

		expect(startCalls).toBe(1);
		expect(kernels[0]?.execute).toHaveBeenCalledTimes(2);
	});

	it("keeps shared retained kernels alive until the last owner is disposed", async () => {
		await executeRuby("puts 1", {
			cwd: "/tmp/shared-owner",
			sessionId: "shared-session",
			kernelOwnerId: "owner-a",
		});
		await executeRuby("puts 2", {
			cwd: "/tmp/shared-owner",
			sessionId: "shared-session",
			kernelOwnerId: "owner-b",
		});

		expect(startCalls).toBe(1);
		expect(kernels[0]?.execute).toHaveBeenCalledTimes(2);

		await disposeRubyKernelSessionsByOwner("owner-a");
		expect(kernels[0]?.shutdown).not.toHaveBeenCalled();

		await executeRuby("puts 3", {
			cwd: "/tmp/shared-owner",
			sessionId: "shared-session",
			kernelOwnerId: "owner-b",
		});
		expect(startCalls).toBe(1);
		expect(kernels[0]?.execute).toHaveBeenCalledTimes(3);

		await disposeRubyKernelSessionsByOwner("owner-b");
		expect(kernels[0]?.shutdown).toHaveBeenCalledTimes(1);
	});

	it("disposes every retained kernel owned by one owner across session ids and cwd values", async () => {
		await executeRuby("puts 'one'", {
			cwd: "/tmp/owner-a-one",
			sessionId: "session-one",
			kernelOwnerId: "owner-a",
		});
		await executeRuby("puts 'two'", {
			cwd: "/tmp/owner-a-two",
			sessionId: "session-two",
			kernelOwnerId: "owner-a",
		});
		await executeRuby("puts 'other'", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelOwnerId: "owner-b",
		});

		expect(startCalls).toBe(3);

		await disposeRubyKernelSessionsByOwner("owner-a");

		expect(kernels[0]?.shutdown).toHaveBeenCalledTimes(1);
		expect(kernels[1]?.shutdown).toHaveBeenCalledTimes(1);
		expect(kernels[2]?.shutdown).not.toHaveBeenCalled();

		await executeRuby("puts 'still alive'", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelOwnerId: "owner-b",
		});

		expect(startCalls).toBe(3);
		expect(kernels[2]?.execute).toHaveBeenCalledTimes(2);
	});

	it("falls back to the retained session id when no explicit owner id is provided during execution", async () => {
		await executeRuby("puts 'fallback'", {
			cwd: "/tmp/fallback-owner-session",
			sessionId: "fallback-session",
		});

		expect(startCalls).toBe(1);
		expect(kernels[0]?.execute).toHaveBeenCalledTimes(1);

		await disposeRubyKernelSessionsByOwner("fallback-session");

		expect(kernels[0]?.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not reattach a kernel after owner disposal has already claimed it", async () => {
		await executeRuby("1 + 1", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelOwnerId: "owner-a",
		});

		const disposingKernel = kernels[0];
		if (!disposingKernel) throw new Error("Missing kernel");
		
		const shutdownDeferred = Promise.withResolvers<KernelShutdownResult>();
		disposingKernel.shutdown.mockImplementation(() => shutdownDeferred.promise);

		const disposal = disposeRubyKernelSessionsByOwner("owner-a");
		
		await executeRuby("2 + 2", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelOwnerId: "owner-b",
		});

		expect(startCalls).toBe(2);
		const replacementKernel = kernels[1];
		if (!replacementKernel) throw new Error("Missing replacement kernel");

		expect(disposingKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(disposingKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(replacementKernel.shutdown).not.toHaveBeenCalled();

		shutdownDeferred.resolve({ confirmed: true });
		await disposal;

		await disposeRubyKernelSessionsByOwner("owner-b");
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("retains sessions whose kernel shutdown is not confirmed so a later dispose retries", async () => {
		await executeRuby("1", {
			cwd: "/tmp/unconfirmed-shutdown",
			sessionId: "unconfirmed-shutdown-session",
		});

		expect(startCalls).toBe(1);
		const kernel = kernels[0];
		if (!kernel) throw new Error("Missing kernel");

		kernel.shutdown.mockResolvedValueOnce({ confirmed: false });
		await disposeAllRubyKernelSessions();
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);

		// Re-executing the same session must reuse the retained kernel (no new start).
		await executeRuby("2", {
			cwd: "/tmp/unconfirmed-shutdown",
			sessionId: "unconfirmed-shutdown-session",
		});
		expect(startCalls).toBe(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);

		// Swap to a confirmed shutdown so afterEach can drain the retained session.
		kernel.shutdown.mockResolvedValueOnce({ confirmed: true });
		await disposeAllRubyKernelSessions();
		expect(kernel.shutdown).toHaveBeenCalledTimes(2);
	});

	it("retains owner mapping when owner-scoped shutdown is not confirmed", async () => {
		await executeRuby("1", {
			cwd: "/tmp/unconfirmed-owner-shutdown",
			sessionId: "unconfirmed-owner-shutdown-session",
			kernelOwnerId: "owner-a",
		});

		const kernel = kernels[0];
		if (!kernel) throw new Error("Missing kernel");

		kernel.shutdown.mockResolvedValueOnce({ confirmed: false });
		await disposeRubyKernelSessionsByOwner("owner-a");
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);

		kernel.shutdown.mockResolvedValueOnce({ confirmed: true });
		await disposeRubyKernelSessionsByOwner("owner-a");
		expect(kernel.shutdown).toHaveBeenCalledTimes(2);
	});

	it("resets the session kernel when requested and coalesces concurrent resets", async () => {
		await executeRuby("1", { cwd: "/tmp/reset-session", sessionId: "reset-session" });
		expect(startCalls).toBe(1);
		const kernel1 = kernels[0];
		if (!kernel1) throw new Error("Missing kernel");

		const shutdownDeferred = Promise.withResolvers<KernelShutdownResult>();
		kernel1.shutdown.mockImplementation(() => shutdownDeferred.promise);

		const p1 = executeRuby("2", { cwd: "/tmp/reset-session", sessionId: "reset-session", reset: true });
		const p2 = executeRuby("3", { cwd: "/tmp/reset-session", sessionId: "reset-session", reset: true });

		// Wait a microtask to allow reset promise chaining
		await flushMicrotasks();

		expect(kernel1.shutdown).toHaveBeenCalledTimes(1);
		shutdownDeferred.resolve({ confirmed: true });
		
		await Promise.all([p1, p2]);

		expect(startCalls).toBe(2);
		const kernel2 = kernels[1];
		if (!kernel2) throw new Error("Missing kernel");
		
		expect(kernel2.execute).toHaveBeenCalledTimes(2);
	});

	it("replaces a dead kernel before execution and retries once", async () => {
		await executeRuby("1", { cwd: "/tmp/dead-kernel", sessionId: "dead-kernel-session" });
		expect(startCalls).toBe(1);
		
		const deadKernel = kernels[0];
		if (!deadKernel) throw new Error("Missing kernel");
		
		// Mark it dead so the next execute replaces it
		deadKernel.alive = false;

		await executeRuby("2", { cwd: "/tmp/dead-kernel", sessionId: "dead-kernel-session" });
		
		expect(startCalls).toBe(2);
		const replacementKernel = kernels[1];
		if (!replacementKernel) throw new Error("Missing replacement kernel");
		
		expect(deadKernel.execute).toHaveBeenCalledTimes(1);
		expect(deadKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
	});
});
