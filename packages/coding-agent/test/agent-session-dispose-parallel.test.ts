/**
 * Parallelize session dispose so /exit no longer stacks subsystem
 * timeouts. Contracts:
 *  - independent Phase-B branches start before either resolves (causal, not wall-only)
 *  - post-prompt drain is bounded at 5s with the exact warn string
 *  - async-job delivery write lands before sessionManager.close
 *  - Hindsight retain flush lands before sessionManager.close
 *  - idle dispose stays under the 3s perceived-hang budget
 *  - owned AsyncJobManager singleton clears even when dispose rejects
 *  - mnemopi embed shutdown runs even when state.dispose rejects
 *  - detached mnemopi consolidation keeps the shared tiny worker alive
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import * as mnemopiEmbedClientModule from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import { MnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as tinyTitleClientModule from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function hindsightFlushStub(flush: () => Promise<void>): HindsightSessionState {
	const stub = {
		flushRetainQueue: flush,
		dispose: () => {},
	};
	return stub as HindsightSessionState;
}

describe("AgentSession dispose parallelization", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-dispose-parallel-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		const current = session;
		session = undefined;
		if (current) {
			await current.dispose();
		}
		vi.useRealTimers();
		authStorage?.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir?.removeSync();
	});

	async function createSession(options?: {
		ownedAsyncJobManager?: AsyncJobManager;
		disconnectOwnedMcpManager?: () => Promise<void>;
		persist?: boolean;
	}): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = options?.persist
			? SessionManager.create(tempDir.path(), tempDir.path())
			: SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			ownedAsyncJobManager: options?.ownedAsyncJobManager,
			disconnectOwnedMcpManager: options?.disconnectOwnedMcpManager,
			agentId: "Main",
		});
		return session;
	}

	it("starts independent Phase-B branches before either resolves", async () => {
		const asyncStarted = deferred();
		const hindsightStarted = deferred();
		const asyncGate = deferred();
		const hindsightGate = deferred();
		const order: string[] = [];

		const owned = {
			dispose: async (_opts?: { timeoutMs?: number }) => {
				order.push("async:start");
				asyncStarted.resolve();
				await asyncGate.promise;
				order.push("async:end");
				return true;
			},
			// #cancelOwnAsyncJobs calls cancelAll on the scoped manager before dispose.
			cancelAll: () => {},
			getDeliveryState: () => ({
				queued: 0,
				delivering: false,
				pendingJobIds: [] as string[],
			}),
		} as AsyncJobManager;

		const s = await createSession({ ownedAsyncJobManager: owned });
		s.setHindsightSessionState(
			hindsightFlushStub(async () => {
				order.push("hindsight:start");
				hindsightStarted.resolve();
				await hindsightGate.promise;
				order.push("hindsight:end");
			}),
		);

		const disposePromise = s.dispose();
		try {
			// Causal barrier: both branches must have entered before either finishes.
			// Start order between branches is not fixed — only that both start first.
			await Promise.all([asyncStarted.promise, hindsightStarted.promise]);
			expect(order).toContain("async:start");
			expect(order).toContain("hindsight:start");
			expect(order).not.toContain("async:end");
			expect(order).not.toContain("hindsight:end");
		} finally {
			asyncGate.resolve();
			hindsightGate.resolve();
		}
		await disposePromise;
		session = undefined;

		const asyncStartAt = order.indexOf("async:start");
		const hindsightStartAt = order.indexOf("hindsight:start");
		const firstEnd = Math.min(order.indexOf("async:end"), order.indexOf("hindsight:end"));
		expect(asyncStartAt).toBeGreaterThanOrEqual(0);
		expect(hindsightStartAt).toBeGreaterThanOrEqual(0);
		expect(asyncStartAt).toBeLessThan(firstEnd);
		expect(hindsightStartAt).toBeLessThan(firstEnd);
	});

	it("waits for async-job drain before disposing shared mnemopi state", async () => {
		const asyncStarted = deferred();
		const asyncGate = deferred();
		const order: string[] = [];
		const owned = {
			dispose: async (_opts?: { timeoutMs?: number }) => {
				order.push("async:start");
				asyncStarted.resolve();
				await asyncGate.promise;
				order.push("async:end");
				return true;
			},
			cancelAll: () => {},
			getDeliveryState: () => ({ queued: 0, delivering: false, pendingJobIds: [] as string[] }),
		} as AsyncJobManager;
		const mnemopiState: MnemopiSessionState = Object.create(MnemopiSessionState.prototype);
		vi.spyOn(mnemopiState, "dispose").mockImplementation(async () => {
			order.push("mnemopi:dispose");
		});

		const s = await createSession({ ownedAsyncJobManager: owned });
		setMnemopiSessionState(s, mnemopiState);
		const disposePromise = s.dispose();
		try {
			await asyncStarted.promise;
			expect(order).toEqual(["async:start"]);
		} finally {
			asyncGate.resolve();
		}
		await disposePromise;
		session = undefined;

		expect(order).toEqual(["async:start", "async:end", "mnemopi:dispose"]);
	});

	it("waits for async-job drain before disconnecting the shared MCP manager", async () => {
		const asyncStarted = deferred();
		const asyncGate = deferred();
		const order: string[] = [];
		const owned = {
			dispose: async (_opts?: { timeoutMs?: number }) => {
				order.push("async:start");
				asyncStarted.resolve();
				await asyncGate.promise;
				order.push("async:end");
				return true;
			},
			cancelAll: () => {},
			getDeliveryState: () => ({ queued: 0, delivering: false, pendingJobIds: [] as string[] }),
		} as AsyncJobManager;

		const s = await createSession({
			ownedAsyncJobManager: owned,
			disconnectOwnedMcpManager: async () => {
				order.push("mcp:disconnect");
			},
		});
		const disposePromise = s.dispose();
		try {
			await asyncStarted.promise;
			expect(order).toEqual(["async:start"]);
		} finally {
			asyncGate.resolve();
		}
		await disposePromise;
		session = undefined;

		expect(order).toEqual(["async:start", "async:end", "mcp:disconnect"]);
	});

	it("keeps session storage open for a post-prompt writer past the dispose deadline", async () => {
		vi.useFakeTimers();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const lateWriteGate = deferred();
		const closeCalled = deferred();
		const order: string[] = [];
		const s = await createSession({ persist: true });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const sessionFile = s.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const lateWrite = lateWriteGate.promise.then(() => {
			s.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "late-write" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			order.push("write");
		});
		s.trackPostPromptTaskForTests(lateWrite);
		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			order.push("close");
			await originalClose();
			closeCalled.resolve();
		};

		const disposePromise = s.dispose();
		vi.advanceTimersByTime(5_000);
		await disposePromise;
		expect(order).toEqual([]);

		lateWriteGate.resolve();
		await lateWrite;
		await closeCalled.promise;
		session = undefined;

		expect(order).toEqual(["write", "close"]);
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("late-write");
	});

	it("bounds a never-settling post-prompt task at 5s and logs the exact warn", async () => {
		// Real platform clock: withTimeout is implemented with setTimeout, and
		// awaiting dispose under fake timers leaves the deadline timer unfired
		// while the hang task never settles. This is the intentional 5s hang-fix.
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const hang = deferred(); // intentionally never resolved

		const s = await createSession();
		s.trackPostPromptTaskForTests(hang.promise);
		expect(s.hasPostPromptWork).toBe(true);

		const started = performance.now();
		await s.dispose();
		session = undefined;
		const elapsed = performance.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(4_500);
		expect(elapsed).toBeLessThan(7_000);
		expect(warnSpy.mock.calls.some(call => call[0] === "Post-prompt tasks still draining at dispose deadline")).toBe(
			true,
		);
	}, 15_000);

	it("writes async-job delivery entries before sessionManager.close", async () => {
		const order: string[] = [];
		const deliveryGate = deferred();
		const deliveryEntered = deferred();

		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 2,
			retentionMs: 1_000,
			onJobComplete: async (jobId, text) => {
				deliveryEntered.resolve();
				await deliveryGate.promise;
				const manager = session?.sessionManager;
				if (!manager) throw new Error("session missing during delivery");
				manager.appendCustomMessageEntry("async-result", `delivery:${jobId}:${text}`, true, { jobId }, "agent");
				order.push("delivery-write");
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		const s = await createSession({ ownedAsyncJobManager: asyncJobManager, persist: true });
		const sessionFile = s.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");

		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			order.push("close");
			await originalClose();
		};

		asyncJobManager.register("bash", "writer job", async () => "payload", {
			id: "writer-job",
			ownerId: "Main",
		});

		// Await the real delivery-entry signal rather than a guessed sleep.
		await deliveryEntered.promise;

		const disposePromise = s.dispose();
		// Release delivery after dispose has started so drain must complete first.
		deliveryGate.resolve();
		await disposePromise;
		session = undefined;

		expect(order[0]).toBe("delivery-write");
		expect(order).toContain("close");
		const writeAt = order.indexOf("delivery-write");
		const closeAt = order.indexOf("close");
		expect(writeAt).toBeGreaterThanOrEqual(0);
		expect(closeAt).toBeGreaterThan(writeAt);

		// Prefer in-memory entries (always available post-close); fall back to
		// the on-disk JSONL when the file still exists after close.
		const entries = s.sessionManager.getEntries();
		const hasDelivery = entries.some(entry => {
			if (entry.type !== "custom_message") return false;
			const content = entry.content;
			const text = typeof content === "string" ? content : JSON.stringify(content);
			return text.includes("delivery:writer-job:payload");
		});
		if (!hasDelivery && fs.existsSync(sessionFile)) {
			const body = fs.readFileSync(sessionFile, "utf8");
			expect(body).toContain("delivery:writer-job:payload");
		} else {
			expect(hasDelivery).toBe(true);
		}
	});

	it("flushes Hindsight retain queue before sessionManager.close", async () => {
		const order: string[] = [];
		const flushGate = deferred();
		const flushEntered = deferred();

		const s = await createSession({ persist: true });
		s.setHindsightSessionState(
			hindsightFlushStub(async () => {
				order.push("hindsight-flush:start");
				flushEntered.resolve();
				await flushGate.promise;
				order.push("hindsight-flush:end");
			}),
		);

		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			order.push("close");
			await originalClose();
		};

		const disposePromise = s.dispose();
		try {
			// Hang the Phase-B Hindsight writer across dispose start: while the
			// flush pends the allSettled barrier cannot settle, so Phase C close
			// must not be observed. Deterministic — close only runs post-barrier.
			await flushEntered.promise;
			expect(order).toContain("hindsight-flush:start");
			expect(order).not.toContain("close");
		} finally {
			// Resolve even on assertion failure so the unbounded flush cannot
			// wedge this dispose or the afterEach re-dispose.
			flushGate.resolve();
		}
		await disposePromise;
		session = undefined;

		const flushEndAt = order.indexOf("hindsight-flush:end");
		const closeAt = order.indexOf("close");
		expect(flushEndAt).toBeGreaterThanOrEqual(0);
		expect(closeAt).toBeGreaterThan(flushEndAt);
	});

	it("idle dispose completes under the 3s status budget", async () => {
		// Integration wall-clock check against the real platform clock: the
		// perceived-hang status arms at 3s, and empty/idle dispose must finish
		// under that without a pending network flush. Fake timers would not
		// exercise the real subsystem teardown path.
		const s = await createSession();
		const started = performance.now();
		await s.dispose();
		session = undefined;
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(3_000);
	});

	it("shuts down the shared tiny-model client after mnemopi disposal completes", async () => {
		const mnemopiStarted = deferred();
		const mnemopiGate = deferred();
		const order: string[] = [];
		const terminateSpy = vi.spyOn(tinyTitleClientModule.tinyTitleClient, "terminate").mockImplementation(async () => {
			order.push("tiny:shutdown");
		});
		const mnemopiState: MnemopiSessionState = Object.create(MnemopiSessionState.prototype);
		vi.spyOn(mnemopiState, "dispose").mockImplementation(async options => {
			order.push("mnemopi:start");
			mnemopiStarted.resolve();
			await mnemopiGate.promise;
			order.push("mnemopi:end");
			await options?.onConsolidationSettled?.();
		});

		const s = await createSession();
		setMnemopiSessionState(s, mnemopiState);
		const disposePromise = s.dispose();
		try {
			await mnemopiStarted.promise;
			expect(terminateSpy).not.toHaveBeenCalled();
		} finally {
			mnemopiGate.resolve();
			await disposePromise;
			session = undefined;
		}

		expect(order).toEqual(["mnemopi:start", "mnemopi:end", "tiny:shutdown"]);
	});

	it("keeps the tiny-model client alive while timed-out consolidation continues detached", async () => {
		const mnemopiStarted = deferred();
		const consolidationGate = deferred();
		const detachedCleanupSettled = deferred();
		const terminateSpy = vi.spyOn(tinyTitleClientModule.tinyTitleClient, "terminate").mockResolvedValue();
		const mnemopiState: MnemopiSessionState = Object.create(MnemopiSessionState.prototype);
		vi.spyOn(mnemopiState, "dispose").mockImplementation(async options => {
			mnemopiStarted.resolve();
			void consolidationGate.promise.then(async () => {
				await options?.onConsolidationSettled?.();
				detachedCleanupSettled.resolve();
			});
		});

		const s = await createSession();
		setMnemopiSessionState(s, mnemopiState);
		const disposePromise = s.dispose({ mnemopiConsolidateTimeoutMs: 1 });
		try {
			await mnemopiStarted.promise;
			await disposePromise;
			session = undefined;
			expect(terminateSpy).not.toHaveBeenCalled();
		} finally {
			consolidationGate.resolve();
			await detachedCleanupSettled.promise;
		}

		expect(terminateSpy).toHaveBeenCalledTimes(1);
	});

	it("clears owned AsyncJobManager singleton when dispose rejects", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const owned = new AsyncJobManager({ onJobComplete: () => {} });
		vi.spyOn(owned, "dispose").mockRejectedValue(new Error("owned async dispose boom"));
		AsyncJobManager.setInstance(owned);

		const s = await createSession({ ownedAsyncJobManager: owned });
		const disposePromise = s.dispose();
		session = undefined;
		await expect(disposePromise).rejects.toThrow("Session dispose subsystem failures");

		expect(AsyncJobManager.instance()).toBeUndefined();
		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Session dispose subsystem failed during parallel teardown" &&
					String((call[1] as { error?: unknown } | undefined)?.error ?? "").includes("owned async dispose boom"),
			),
		).toBe(true);
	});

	it("shuts down mnemopi embed client when state.dispose rejects", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// Runtime method resolution through the module-level singleton — not the
		// static named import of shutdownMnemopiEmbedClient — so the spy is observed.
		const terminateSpy = vi
			.spyOn(mnemopiEmbedClientModule.mnemopiEmbedClient, "terminate")
			.mockResolvedValue(undefined);

		const order: string[] = [];
		const rejectingState: MnemopiSessionState = Object.create(MnemopiSessionState.prototype);
		vi.spyOn(rejectingState, "dispose").mockImplementation(async () => {
			order.push("mnemopi:dispose");
			throw new Error("mnemopi dispose boom");
		});

		const s = await createSession();
		setMnemopiSessionState(s, rejectingState);
		const disposePromise = s.dispose();
		session = undefined;
		await expect(disposePromise).rejects.toThrow("Session dispose subsystem failures");

		order.push("after-dispose");
		expect(order).toEqual(["mnemopi:dispose", "after-dispose"]);
		expect(terminateSpy).toHaveBeenCalled();
		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Session dispose subsystem failed during parallel teardown" &&
					String((call[1] as { error?: unknown } | undefined)?.error ?? "").includes("mnemopi dispose boom"),
			),
		).toBe(true);
	});
});
