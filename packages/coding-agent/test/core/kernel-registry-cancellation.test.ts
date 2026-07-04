import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	KernelSessionRegistry,
	type RegistryExecutorOptions,
	type RegistryKernel,
} from "@oh-my-pi/pi-coding-agent/eval/executor-base";

class TestCancelledError extends Error {
	timedOut: boolean;
	constructor(timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.timedOut = timedOut;
	}
}

class FakeKernel implements RegistryKernel {
	alive = true;
	shutdown = vi.fn(async () => {
		this.alive = false;
		return { confirmed: true };
	});

	isAlive(): boolean {
		return this.alive;
	}
}

interface TestOptions extends RegistryExecutorOptions {
	cwd: string;
}

class TestRegistry extends KernelSessionRegistry<FakeKernel, TestOptions, string> {
	readonly languageLabel = "Test";
	readonly cancelledErrorClass = TestCancelledError;
	startKernel = vi.fn(async () => new FakeKernel());

	async runOnKernel(kernel: FakeKernel, code: string, _options: TestOptions): Promise<string> {
		return `${code}:${kernel.isAlive()}`;
	}
}

async function flushMicrotasks(turns = 6): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await Promise.resolve();
	}
}

describe("KernelSessionRegistry cancellation", () => {
	let registry: TestRegistry;

	beforeEach(() => {
		registry = new TestRegistry();
	});

	afterEach(async () => {
		await registry.disposeAll();
		vi.restoreAllMocks();
	});

	it("rejects a joiner promptly when its own signal aborts while startup is in flight", async () => {
		let finishStartup: (kernel: FakeKernel) => void = () => {};
		registry.startKernel = vi.fn(async () => {
			const { promise, resolve } = Promise.withResolvers<FakeKernel>();
			finishStartup = resolve;
			return await promise;
		});

		const firstController = new AbortController();
		const firstPromise = registry.executeOnSession("first", {
			cwd: "/tmp/a",
			sessionId: "s1",
			signal: firstController.signal,
		});
		await flushMicrotasks();

		const joinerController = new AbortController();
		const joinerPromise = registry.executeOnSession("joiner", {
			cwd: "/tmp/a",
			sessionId: "s1",
			signal: joinerController.signal,
		});
		await flushMicrotasks();

		joinerController.abort();
		await expect(joinerPromise).rejects.toBeInstanceOf(TestCancelledError);

		// Startup is still in flight; the first caller should remain pending.
		let firstSettled = false;
		firstPromise.then(() => {
			firstSettled = true;
		});
		await flushMicrotasks();
		expect(firstSettled).toBe(false);

		// Clean up the first caller.
		finishStartup(new FakeKernel());
		await firstPromise;
	});

	it("shuts down the started kernel when the first starter is cancelled before registration completes", async () => {
		let finishStartup: (kernel: FakeKernel) => void = () => {};
		registry.startKernel = vi.fn(async () => {
			const { promise, resolve } = Promise.withResolvers<FakeKernel>();
			finishStartup = resolve;
			return await promise;
		});

		const controller = new AbortController();
		const promise = registry.executeOnSession("first", {
			cwd: "/tmp/a",
			sessionId: "s1",
			signal: controller.signal,
		});
		await flushMicrotasks();

		controller.abort();
		await expect(promise).rejects.toBeInstanceOf(TestCancelledError);

		const kernel = new FakeKernel();
		finishStartup(kernel);
		await flushMicrotasks();

		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});
});
