import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import {
	__providerInFlightForTesting,
	configureProviderMaxInFlightRequests,
	streamSimple,
} from "@oh-my-pi/pi-ai/stream";
import type { Context } from "@oh-my-pi/pi-ai/types";

function context(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

let limiterRoot: string | undefined;

afterEach(async () => {
	clearCustomApis();
	configureProviderMaxInFlightRequests(undefined);
	__providerInFlightForTesting.setRoot(undefined);
	__providerInFlightForTesting.resetReducedLimits();
	if (limiterRoot !== undefined) {
		await fs.rm(limiterRoot, { recursive: true, force: true });
		limiterRoot = undefined;
	}
});

async function useIsolatedLimiterRoot(): Promise<void> {
	limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-inflight-test-"));
	__providerInFlightForTesting.setRoot(limiterRoot);
}

function limiterDir(provider: string): string {
	return __providerInFlightForTesting.providerDir(provider);
}

describe("provider in-flight request limits", () => {
	beforeEach(async () => {
		await useIsolatedLimiterRoot();
	});
	test("serializes concurrent streamSimple calls for the same provider", async () => {
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		let callIndex = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				callIndex++;
				active++;
				maxActive = Math.max(maxActive, active);
				try {
					if (callIndex === 1) {
						firstStarted.resolve();
						await releaseFirst.promise;
					}
					return { content: [`reply ${callIndex}`] };
				} finally {
					active--;
				}
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		const second = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		await Bun.sleep(20);
		expect(mock.calls).toHaveLength(1);

		releaseFirst.resolve();
		const [firstMessage, secondMessage] = await Promise.all([firstResult, second.result()]);

		expect(firstMessage.content).toEqual([{ type: "text", text: "reply 1" }]);
		expect(secondMessage.content).toEqual([{ type: "text", text: "reply 2" }]);
		expect(maxActive).toBe(1);
		expect(mock.calls).toHaveLength(2);
	});

	test("allows one in-flight request per credential for the same provider", async () => {
		registerMockApi();
		const bothStarted = Promise.withResolvers<void>();
		const releaseBoth = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				if (active === 2) bothStarted.resolve();
				try {
					await releaseBoth.promise;
					return { content: ["reply"] };
				} finally {
					active--;
				}
			},
		});

		const options = { maxInFlightRequests: { tests: 1 } };
		const first = streamSimple(mock.model, context(), { ...options, credentialId: 1 });
		const second = streamSimple(mock.model, context(), { ...options, credentialId: 2 });
		await bothStarted.promise;

		expect(mock.calls).toHaveLength(2);
		expect(maxActive).toBe(2);
		releaseBoth.resolve();
		await Promise.all([first.result(), second.result()]);
	});

	test("removes an aborted queued request without dispatching it", async () => {
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let callIndex = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				callIndex++;
				if (callIndex === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return { content: [`reply ${callIndex}`] };
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		const controller = new AbortController();
		const second = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});
		controller.abort(new Error("cancel queued request"));

		await expect(second.result()).rejects.toThrow("cancel queued request");
		expect(mock.calls).toHaveLength(1);

		releaseFirst.resolve();
		await firstResult;
		expect(mock.calls).toHaveLength(1);
	});

	test("shares limits with leases created by another process", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const externalLease = path.join(providerDir, "external");
		await fs.mkdir(externalLease, { recursive: true });
		await Bun.write(
			path.join(externalLease, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "external" }),
		);

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(150);
		expect(mock.calls).toHaveLength(0);

		await fs.rm(externalLease, { recursive: true, force: true });
		await Bun.write(path.join(providerDir, ".wakeup"), String(Date.now()));
		const result = await stream.result();
		expect(result.content).toEqual([{ type: "text", text: "reply" }]);
		expect(mock.calls).toHaveLength(1);
	});

	test("does not signal waiters when no slot was freed", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const externalLease = path.join(providerDir, "external");
		await fs.mkdir(externalLease, { recursive: true });
		await Bun.write(
			path.join(externalLease, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "external" }),
		);

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(50);
		expect(await Bun.file(path.join(providerDir, ".wakeup")).exists()).toBe(false);
		expect(mock.calls).toHaveLength(0);

		controller.abort(new Error("cancel saturated waiter"));
		await expect(stream.result()).rejects.toThrow("cancel saturated waiter");
	});

	test("does not signal waiters when acquiring a slot", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				firstStarted.resolve();
				await releaseFirst.promise;
				return { content: ["reply"] };
			},
		});

		const stream = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		await firstStarted.promise;

		expect(await Bun.file(path.join(providerDir, ".wakeup")).exists()).toBe(false);

		releaseFirst.resolve();
		const result = await stream.result();
		expect(result.content).toEqual([{ type: "text", text: "reply" }]);
	});

	test("does not reap a live lock just because its timestamp is old", async () => {
		registerMockApi();
		const lockDir = __providerInFlightForTesting.lockDir("tests");
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now() - 60_000, token: "live-lock" }),
		);

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(150);
		expect(mock.calls).toHaveLength(0);

		controller.abort(new Error("cancel lock waiter"));
		await expect(stream.result()).rejects.toThrow("cancel lock waiter");
		expect(mock.calls).toHaveLength(0);
	});

	test("treats unreadable fresh lease info as active", async () => {
		registerMockApi();
		const providerDir = limiterDir("tests");
		const externalLease = path.join(providerDir, "partial-info");
		await fs.mkdir(externalLease, { recursive: true });
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(externalLease, old, old);
		await Bun.write(path.join(externalLease, "info.json"), "{");

		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		await Bun.sleep(150);
		expect(mock.calls).toHaveLength(0);

		controller.abort(new Error("cancel partial-info waiter"));
		await expect(stream.result()).rejects.toThrow("cancel partial-info waiter");
		expect(mock.calls).toHaveLength(0);
	});

	test("does not delete a fresh lock after observing a stale lock", async () => {
		const lockDir = __providerInFlightForTesting.lockDir("tests");
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: 999999, timestamp: Date.now() - 60_000, token: "stale-lock" }),
		);
		const staleRelease = await __providerInFlightForTesting.captureStaleLockRelease("tests");
		expect(staleRelease).not.toBeNull();

		await fs.rm(lockDir, { recursive: true, force: true });
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "fresh-lock" }),
		);

		await staleRelease?.();

		const remaining = JSON.parse(await Bun.file(path.join(lockDir, "info.json")).text()) as { token: string };
		expect(remaining.token).toBe("fresh-lock");
	});

	test("does not delete a fresh lock after a write-failure cleanup observes an old lock", async () => {
		const lockDir = __providerInFlightForTesting.lockDir("tests");
		await fs.mkdir(lockDir, { recursive: true });
		const staleCleanup = await __providerInFlightForTesting.captureLockDirRelease("tests");
		expect(staleCleanup).not.toBeNull();

		await fs.rm(lockDir, { recursive: true, force: true });
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "fresh-lock" }),
		);

		await staleCleanup?.();

		const remaining = JSON.parse(await Bun.file(path.join(lockDir, "info.json")).text()) as { token: string };
		expect(remaining.token).toBe("fresh-lock");
	});

	test("does not dispatch when aborted immediately after slot acquisition", async () => {
		registerMockApi();
		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		controller.abort(new Error("cancel acquired request"));

		await expect(stream.result()).rejects.toThrow("cancel acquired request");
		expect(mock.calls).toHaveLength(0);
	});

	test("adapts static API keys after a concurrent-limit response", async () => {
		registerMockApi();
		const mock = createMockModel({
			provider: "tests",
			responses: [{ errorMessage: "concurrent_limit_reached", stopReason: "error" }, { content: ["recovered"] }],
		});
		const waits: number[] = [];

		const result = await streamSimple(mock.model, context(), {
			apiKey: "static-key",
			maxInFlightRequests: { tests: 2 },
			providerRetryWait: async delayMs => void waits.push(delayMs),
		}).result();

		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(mock.calls.map(call => call.options?.apiKey)).toEqual(["static-key", "static-key"]);
		expect(waits).toEqual([5_000]);
	});

	test("adapts keyless direct providers after a concurrent-limit response", async () => {
		registerMockApi();
		const mock = createMockModel({
			provider: "tests",
			responses: [{ errorMessage: "concurrent_limit_reached", stopReason: "error" }, { content: ["recovered"] }],
		});
		const waits: number[] = [];

		await expect(
			streamSimple(mock.model, context(), {
				maxInFlightRequests: { tests: 2 },
				providerRetryWait: async delayMs => void waits.push(delayMs),
			}).result(),
		).resolves.toMatchObject({ content: [{ type: "text", text: "recovered" }] });
		expect(mock.calls).toHaveLength(2);
		expect(waits).toEqual([5_000]);
	});

	test("does not let a learned cap exceed a lowered live static-key cap", async () => {
		registerMockApi();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				calls += 1;
				if (calls === 1) return { errorMessage: "concurrent_request_limit_reached", stopReason: "error" };
				if (calls === 2) return { content: ["learned"] };
				if (calls === 3) {
					started.resolve();
					await release.promise;
				}
				return { content: ["done"] };
			},
		});

		await streamSimple(mock.model, context(), {
			apiKey: "static-key",
			maxInFlightRequests: { tests: 3 },
			providerRetryWait: async () => {},
		}).result();
		const first = streamSimple(mock.model, context(), { apiKey: "static-key", maxInFlightRequests: { tests: 1 } });
		await started.promise;
		const second = streamSimple(mock.model, context(), { apiKey: "static-key", maxInFlightRequests: { tests: 1 } });
		await Bun.sleep(20);
		expect(calls).toBe(3);

		release.resolve();
		await Promise.all([first.result(), second.result()]);
		expect(calls).toBe(4);
	});

	test("aborts a static-key concurrent-limit backoff without waiting", async () => {
		registerMockApi();
		const controller = new AbortController();
		const backoffStarted = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "tests",
			responses: [{ errorMessage: "concurrent_limit_reached", stopReason: "error" }],
		});
		const stream = streamSimple(mock.model, context(), {
			apiKey: "static-key",
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
			providerRetryWait: async (_delayMs, signal) => {
				backoffStarted.resolve();
				const aborted = Promise.withResolvers<never>();
				signal?.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
				await aborted.promise;
			},
		});
		const result = stream.result();
		await backoffStarted.promise;
		controller.abort();
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(mock.calls).toHaveLength(1);
	});

	test("uses opaque path segments for provider ids", async () => {
		const dir = limiterDir("..");
		const relative = path.relative(limiterRoot!, dir);

		expect(relative).not.toBe("");
		expect(relative.startsWith("..")).toBe(false);
		expect(path.isAbsolute(relative)).toBe(false);
	});
});
