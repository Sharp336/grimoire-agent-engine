import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	disposeAllRustKernelSessions,
	disposeRustKernelSessionsByOwner,
	executeRust,
	executeRustWithKernel,
	type RustKernelExecutor,
} from "@oh-my-pi/pi-coding-agent/eval/rs/executor";
import type { RustKernelExecuteOptions, RustKernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/rs/kernel";
import { RustKernel } from "@oh-my-pi/pi-coding-agent/eval/rs/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

class FakeRustKernel implements RustKernelExecutor {
	executeCalls = 0;
	shutdownCalls = 0;
	alive = true;
	readonly id: string;

	constructor(id: string) {
		this.id = id;
	}

	async execute(_code: string, options?: RustKernelExecuteOptions): Promise<RustKernelExecuteResult> {
		this.executeCalls += 1;
		if (options?.onChunk) {
			await options.onChunk("ok\n");
		}
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	async shutdown(): Promise<{ confirmed: boolean }> {
		this.shutdownCalls += 1;
		this.alive = false;
		return { confirmed: true };
	}

	isAlive(): boolean {
		return this.alive;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}
}

describe("Rust executor lifecycle", () => {
	const originalStart = RustKernel.start;
	let startCalls = 0;
	let kernels: FakeRustKernel[] = [];
	let prevSkipCheck: string | undefined;

	beforeEach(() => {
		prevSkipCheck = Bun.env.PI_RUST_SKIP_CHECK;
		Bun.env.PI_RUST_SKIP_CHECK = "1";
		startCalls = 0;
		kernels = [];
		// Use a local cast (allowed exception) to mock the kernel creation for the lifecycle tests,
		// as we only need the FakeRustKernel interface internally.
		RustKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeRustKernel(`rust-kernel-${startCalls}`);
			kernels.push(kernel);
			return kernel as unknown as RustKernel;
		}) as typeof RustKernel.start;
	});

	afterEach(async () => {
		RustKernel.start = originalStart;
		if (prevSkipCheck === undefined) {
			delete Bun.env.PI_RUST_SKIP_CHECK;
		} else {
			Bun.env.PI_RUST_SKIP_CHECK = prevSkipCheck;
		}
		await disposeAllRustKernelSessions();
	});

	describe("session-lifecycle group", () => {
		it("reuses kernels for the same sessionId and cwd", async () => {
			using tempDir = TempDir.createSync("@rust-kernel-session-");
			await executeRust("let one = 1;", { cwd: tempDir.path(), sessionId: "session-a" });
			await executeRust("let two = 2;", { cwd: tempDir.path(), sessionId: "session-a" });

			expect(startCalls).toBe(1);
			expect(kernels[0]?.executeCalls).toBe(2);
		});

		it("resets the session kernel when requested", async () => {
			using tempDir = TempDir.createSync("@rust-kernel-session-");
			await executeRust("let one = 1;", { cwd: tempDir.path(), sessionId: "session-b" });
			await executeRust("let two = 2;", {
				cwd: tempDir.path(),
				sessionId: "session-b",
				reset: true,
			});

			expect(startCalls).toBe(2);
			expect(kernels[0]?.shutdownCalls).toBe(1);
		});

		it("survives first owner dispose and shuts down on second", async () => {
			using tempDir = TempDir.createSync("@rust-kernel-session-");
			await executeRust("let one = 1;", { cwd: tempDir.path(), sessionId: "session-c", kernelOwnerId: "owner-1" });
			await executeRust("let two = 2;", { cwd: tempDir.path(), sessionId: "session-c", kernelOwnerId: "owner-2" });

			expect(startCalls).toBe(1);
			expect(kernels[0]?.executeCalls).toBe(2);

			await disposeRustKernelSessionsByOwner("owner-1");
			expect(kernels[0]?.shutdownCalls).toBe(0);

			await disposeRustKernelSessionsByOwner("owner-2");
			expect(kernels[0]?.shutdownCalls).toBe(1);
		});
	});

	describe("direct-execution group", () => {
		it("returns cancelled immediately if signal is already aborted", async () => {
			const fakeKernel = new FakeRustKernel("fake-1");
			const controller = new AbortController();
			controller.abort(new Error("already dead"));

			const result = await executeRustWithKernel(fakeKernel, "1 + 1", { signal: controller.signal });

			expect(result.cancelled).toBe(true);
			expect(fakeKernel.executeCalls).toBe(0);
		});

		it("rejects concurrent calls on the same kernel with a single-flight error", async () => {
			const fakeKernel = new FakeRustKernel("fake-2");
			const { promise: lockPromise, resolve: resolveFirst } = Promise.withResolvers<void>();

			// Override execute to hang until we resolve it
			fakeKernel.execute = async () => {
				fakeKernel.executeCalls += 1;
				await lockPromise;
				return { status: "ok", cancelled: false, timedOut: false };
			};

			const p1 = executeRustWithKernel(fakeKernel, "1 + 1", {});

			// Second call should reject because the kernel is locked
			const p2 = executeRustWithKernel(fakeKernel, "2 + 2", {});

			await expect(p2).rejects.toThrow("concurrent");
			expect(fakeKernel.executeCalls).toBe(1);

			resolveFirst();
			await p1;
			expect(fakeKernel.executeCalls).toBe(1);
		});
	});
});
