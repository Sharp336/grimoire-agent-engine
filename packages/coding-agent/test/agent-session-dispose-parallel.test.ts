/**
 * Parallelize session dispose so /exit no longer stacks subsystem
 * timeouts. Contracts:
 *  - independent Phase-B branches start before either resolves (causal, not wall-only)
 *  - every caller awaits post-prompt quiescence, storage close, and listener teardown
 *  - async-result follow-up writes land before sessionManager.close
 *  - Hindsight retain flush lands before sessionManager.close
 *  - idle dispose stays under the 3s perceived-hang budget
 *  - owned AsyncJobManager singleton clears even when dispose rejects
 *  - mnemopi embed shutdown runs even when state.dispose rejects
 *  - detached mnemopi consolidation keeps the shared tiny worker alive
 *  - async-shared browser tabs are released only after the async-job drain
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
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
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, getTabsMapForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 100; i++) await Promise.resolve();
}

function hindsightFlushStub(flush: () => Promise<void>): HindsightSessionState {
	const stub = {
		flushRetainQueue: flush,
		dispose: () => {},
	};
	return stub as HindsightSessionState;
}

function setMnemopiProviderLlm(state: MnemopiSessionState, llm: object | false): void {
	Object.defineProperty(state, "config", {
		value: { providerOptions: { llm } },
		configurable: true,
	});
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
		sideStreamFn?: StreamFn;
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
			sideStreamFn: options?.sideStreamFn,
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

	it("waits for async-job drain before releasing shared parent-owned browser tabs", async () => {
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
		vi.spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		vi.spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		vi.spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					return { surface_id: "dispose-shared-tab", url: "about:blank" };
				}
				return {};
			},
		);

		const s = await createSession({ ownedAsyncJobManager: owned });
		const ownerId = s.sessionManager.getSessionId();
		if (!ownerId) throw new Error("expected session id for browser tab ownership");
		const browser = await acquireBrowser(
			{ kind: "cmux", socketPath: "/tmp/omp-dispose-shared-tab.sock", surface: "dispose-shared-tab" },
			{ cwd: "/tmp" },
		);
		await acquireTab("dispose-shared-tab", browser, { timeoutMs: 1_000, ownerSessionId: ownerId });

		const disposePromise = s.dispose();
		try {
			await asyncStarted.promise;
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(order).toEqual(["async:start"]);
			expect(getTabsMapForTest().has("dispose-shared-tab")).toBe(true);
		} finally {
			asyncGate.resolve();
		}
		await disposePromise;
		session = undefined;

		expect(order).toEqual(["async:start", "async:end"]);
		expect(getTabsMapForTest().has("dispose-shared-tab")).toBe(false);
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

	it("does not resolve a programmatic dispose until a post-prompt write is persisted and storage is closed", async () => {
		vi.useFakeTimers();
		const lateWriteGate = deferred();
		const order: string[] = [];
		const s = await createSession({ persist: true });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const sessionFile = s.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const lateWrite = lateWriteGate.promise.then(() => {
			s.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "programmatic-dispose-late-write" }],
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
		};

		const disposePromise = s.dispose().then(() => {
			order.push("dispose:resolved");
		});
		try {
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks();
			expect(order).toEqual([]);
		} finally {
			lateWriteGate.resolve();
			await disposePromise;
			session = undefined;
		}

		expect(order).toEqual(["write", "close", "dispose:resolved"]);
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("programmatic-dispose-late-write");
	});

	it("shares one full finalization promise across concurrent dispose callers", async () => {
		const taskGate = deferred();
		const s = await createSession();
		s.trackPostPromptTaskForTests(taskGate.promise);
		let closeCalls = 0;
		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			closeCalls++;
			await originalClose();
		};

		const first = s.dispose();
		const second = s.dispose();
		expect(second).toBe(first);
		taskGate.resolve();
		await Promise.all([first, second]);
		session = undefined;

		expect(closeCalls).toBe(1);
	});

	it("reports that no agent turn started when prompting a disposed session", async () => {
		const s = await createSession();
		const promptSpy = vi.spyOn(s.agent, "prompt");
		await s.dispose();
		session = undefined;

		expect(await s.prompt("too late")).toBe(false);
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("invalidates a deferred hidden prompt still in setup when dispose starts", async () => {
		const apiKeyEntered = deferred();
		const apiKeyGate = deferred();
		const s = await createSession();
		const promptSpy = vi.spyOn(s.agent, "prompt");
		vi.spyOn(s.modelRegistry, "getApiKey").mockImplementation(async () => {
			apiKeyEntered.resolve();
			await apiKeyGate.promise;
			return "test-key";
		});
		s.queueDeferredMessage({
			role: "custom",
			customType: "dispose-hidden-follow-up",
			content: "must not start a provider turn during dispose",
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		await apiKeyEntered.promise;

		const disposePromise = s.dispose();
		apiKeyGate.resolve();
		await disposePromise;
		session = undefined;

		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("aborts an in-flight deferred-handoff provider stream and completes dispose promptly", async () => {
		const providerStarted = deferred();
		let providerObservedAbort = false;
		const sideStreamFn: StreamFn = (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			const signal = options?.signal;
			if (!signal) throw new Error("expected handoff provider abort signal");
			providerStarted.resolve();
			const abort = () => {
				providerObservedAbort = true;
				stream.fail(new DOMException("Provider fetch aborted", "AbortError"));
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
			return stream;
		};
		const s = await createSession({ sideStreamFn });
		const model = s.model;
		if (!model) throw new Error("expected session model");
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "prepare handoff" }],
			timestamp: Date.now(),
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "handoff source" }],
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
		};
		for (const message of [userMessage, assistantMessage]) {
			s.agent.appendMessage(message);
			s.sessionManager.appendMessage(message);
		}

		const handoffPromise = s.handoff();
		s.trackPostPromptTaskForTests(handoffPromise);
		await providerStarted.promise;

		// This integration assertion deliberately uses the platform clock: fake timers
		// cannot prove that the real abort-driven provider unwind makes /exit return.
		let timeout: Timer | undefined;
		const startedAt = performance.now();
		const completed = await Promise.race([
			s.dispose().then(() => true),
			new Promise<boolean>(resolve => {
				timeout = setTimeout(() => resolve(false), 1_000);
			}),
		]).finally(() => clearTimeout(timeout));
		const elapsedMs = performance.now() - startedAt;
		session = undefined;

		expect(completed).toBe(true);
		expect(providerObservedAbort).toBe(true);
		expect(elapsedMs).toBeLessThan(1_000);
		await expect(handoffPromise).rejects.toThrow("Handoff cancelled");
	});

	it("keeps the agent event subscription until a late continuation has drained", async () => {
		vi.useFakeTimers();
		const continueGate = deferred();
		const closeCalled = deferred();
		const s = await createSession({ persist: true });
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "continue after dispose starts" }],
			timestamp: Date.now(),
		};
		s.agent.appendMessage(userMessage);
		s.sessionManager.appendMessage(userMessage);
		const model = s.model;
		if (!model) throw new Error("expected session model");
		const lateAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "late-continue-event" }],
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
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
		vi.spyOn(s.agent, "continue").mockImplementation(async () => {
			s.agent.appendMessage(lateAssistant);
			s.agent.emitExternalEvent({ type: "message_start", message: lateAssistant });
			s.agent.emitExternalEvent({ type: "message_end", message: lateAssistant });
			await flushMicrotasks();
		});
		const lateContinue = continueGate.promise.then(() => s.agent.continue());
		s.trackPostPromptTaskForTests(lateContinue);
		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			await originalClose();
			closeCalled.resolve();
		};

		const disposePromise = s.dispose();
		try {
			vi.advanceTimersByTime(5_000);
			await flushMicrotasks();
		} finally {
			continueGate.resolve();
			await lateContinue;
			await disposePromise;
			await closeCalled.promise;
			session = undefined;
		}

		const persistedMessages = s.sessionManager
			.getEntries()
			.filter(entry => entry.type === "message")
			.map(entry => JSON.stringify(entry.message));
		expect(persistedMessages.some(message => message.includes("late-continue-event"))).toBe(true);
	});

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

	it("persists an async-result follow-up scheduled during async-job drain before storage closes", async () => {
		vi.useFakeTimers();
		const order: string[] = [];
		const deliveryGate = deferred();
		const deliveryEntered = deferred();
		let targetSession: AgentSession | undefined;
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveryEntered.resolve();
				await deliveryGate.promise;
				targetSession?.yieldQueue.enqueue("round7-async-result", { jobId, text });
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		const s = await createSession({ ownedAsyncJobManager: asyncJobManager, persist: true });
		targetSession = s;
		s.yieldQueue.register<{ jobId: string; text: string }>("round7-async-result", {
			build: entries => ({
				role: "custom",
				customType: "async-result",
				content: entries.map(entry => `${entry.jobId}:${entry.text}`).join("\n"),
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			}),
		});
		const originalAppendCustom = s.sessionManager.appendCustomMessageEntry.bind(s.sessionManager);
		s.sessionManager.appendCustomMessageEntry = (customType, content, display, details, attribution) => {
			if (customType === "async-result") order.push("async-result-write");
			return originalAppendCustom(customType, content, display, details, attribution);
		};
		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			order.push("close");
			await originalClose();
		};

		asyncJobManager.register("bash", "follow-up job", async () => "payload", {
			id: "follow-up-job",
			ownerId: "Main",
		});
		await deliveryEntered.promise;
		const disposePromise = s.dispose();
		deliveryGate.resolve();
		try {
			await disposePromise;
			expect(order).toEqual(["async-result-write", "close"]);
		} finally {
			vi.advanceTimersByTime(10);
			await flushMicrotasks();
			session = undefined;
		}
	});

	it("flushes an async-result enqueued after the bounded delivery drain times out", async () => {
		vi.useFakeTimers();
		const order: string[] = [];
		const deliveryGate = deferred();
		const deliveryEntered = deferred();
		let targetSession: AgentSession | undefined;
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveryEntered.resolve();
				await deliveryGate.promise;
				targetSession?.yieldQueue.enqueue("late-async-result", { jobId, text });
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		const s = await createSession({ ownedAsyncJobManager: asyncJobManager, persist: true });
		targetSession = s;
		s.yieldQueue.register<{ jobId: string; text: string }>("late-async-result", {
			build: entries => ({
				role: "custom",
				customType: "async-result",
				content: entries.map(entry => `${entry.jobId}:${entry.text}`).join("\n"),
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			}),
		});
		const originalAppendCustom = s.sessionManager.appendCustomMessageEntry.bind(s.sessionManager);
		s.sessionManager.appendCustomMessageEntry = (customType, content, display, details, attribution) => {
			if (customType === "async-result") order.push("late-async-result-write");
			return originalAppendCustom(customType, content, display, details, attribution);
		};
		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			order.push("close");
			await originalClose();
		};

		asyncJobManager.register("bash", "late delivery", async () => "payload", {
			id: "late-delivery",
			ownerId: "Main",
		});
		await deliveryEntered.promise;
		const disposePromise = s.dispose();
		await flushMicrotasks();
		vi.advanceTimersByTime(3_001);
		await flushMicrotasks();

		// The bounded manager cleanup and initial stable-empty pass have elapsed,
		// but storage must remain open until the live callback can no longer enqueue.
		expect(order).not.toContain("close");
		deliveryGate.resolve();
		await disposePromise;
		session = undefined;

		expect(order).toEqual(["late-async-result-write", "close"]);
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
		setMnemopiProviderLlm(mnemopiState, { complete: async () => null });
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
		setMnemopiProviderLlm(mnemopiState, { complete: async () => null });
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

	it("shuts down the tiny client promptly when remote consolidation remains detached", async () => {
		const terminateSpy = vi.spyOn(tinyTitleClientModule.tinyTitleClient, "terminate").mockResolvedValue();
		const mnemopiState: MnemopiSessionState = Object.create(MnemopiSessionState.prototype);
		setMnemopiProviderLlm(mnemopiState, {
			baseUrl: "https://memory.example.invalid",
			model: "remote-memory-model",
		});
		let deferredCleanup: (() => void | Promise<void>) | undefined;
		vi.spyOn(mnemopiState, "dispose").mockImplementation(async options => {
			// Model MnemopiSessionState.dispose returning on timeout while remote
			// consolidation and its optional settled callback remain detached.
			deferredCleanup = options?.onConsolidationSettled;
		});

		const s = await createSession();
		setMnemopiSessionState(s, mnemopiState);
		await s.dispose({ mnemopiConsolidateTimeoutMs: 1 });
		session = undefined;

		expect(deferredCleanup).toBeUndefined();
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
