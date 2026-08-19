import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	SessionCompactionPrecommitEvent,
	SessionCompactionPrecommitResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

const runtimeSignalStoreKey = "__ompRuntimeSignals";
type RuntimeSignalGlobal = typeof globalThis & {
	[runtimeSignalStoreKey]?: string[];
	__ompManualCompactGate?: Promise<void>;
	__ompPrecommitGate?: Promise<void>;
	__ompPrecommitResult?: SessionCompactionPrecommitResult;
	__ompPrecommitError?: Error;
	__ompPrecommitEntered?: (event: SessionCompactionPrecommitEvent) => void;
	__ompPrecommitFollower?: (event: SessionCompactionPrecommitEvent) => void;
	__ompCompactionDetails?: unknown;
	__ompCompactionPreserveData?: Record<string, unknown>;
	__ompPrecommitMutation?: (event: SessionCompactionPrecommitEvent) => void;
};

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

/**
 * Regression test: auto-compaction completion should resume the agent loop when
 * there are queued agent-level messages (follow-up/steering/custom).
 */
describe("AgentSession auto-compaction queue resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let extensionRunner: ExtensionRunner;
	let reportedExtensionErrors: Array<{ event: string; error: string }>;
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-queue-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	async function setupSession(includePrecommitHandlers = true): Promise<void> {
		// Install the short-circuit extension directly. Loading a generated
		// TypeScript file here used to compile the same fixture for every test.
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => {
					getRuntimeSignals().push("before_compact:enter");
					const gate = (globalThis as RuntimeSignalGlobal).__ompManualCompactGate;
					if (gate) await gate;
					const compaction: CompactionResult = {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: (globalThis as RuntimeSignalGlobal).__ompCompactionDetails ?? {},
						preserveData: (globalThis as RuntimeSignalGlobal).__ompCompactionPreserveData,
					};
					return { compaction };
				});
				if (includePrecommitHandlers) {
					pi.on("session_compaction_precommit", async event => {
						const runtimeGlobal = globalThis as RuntimeSignalGlobal;
						getRuntimeSignals().push(`compaction:precommit:${event.reason}`);
						runtimeGlobal.__ompPrecommitMutation?.(event);
						runtimeGlobal.__ompPrecommitEntered?.(event);
						if (runtimeGlobal.__ompPrecommitGate) await runtimeGlobal.__ompPrecommitGate;
						if (runtimeGlobal.__ompPrecommitError) throw runtimeGlobal.__ompPrecommitError;
						return runtimeGlobal.__ompPrecommitResult;
					});
					pi.on("session_compaction_precommit", event => {
						const runtimeGlobal = globalThis as RuntimeSignalGlobal;
						runtimeGlobal.__ompPrecommitFollower?.(event);
					});
				}
				pi.on("auto_compaction_start", event => {
					getRuntimeSignals().push(`compaction:start:${event.reason}`);
				});
				pi.on("session_compact", () => {
					getRuntimeSignals().push("compaction:post");
				});
				pi.on("auto_compaction_end", event => {
					getRuntimeSignals().push(`compaction:end:${event.aborted ? "aborted" : "ok"}`);
				});
				pi.on("todo_reminder", event => {
					getRuntimeSignals().push(`todo:${event.attempt}/${event.maxAttempts}`);
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"compaction-short-circuit",
		);

		sessionManager = SessionManager.inMemory(tempDir.path());
		getRuntimeSignals().length = 0;

		extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		reportedExtensionErrors = [];
		extensionRunner.onError(error => {
			reportedExtensionErrors.push({ event: error.event, error: error.error });
		});

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		// Pin the window and output reservation: the threshold/usage math below is
		// tuned to a 200k/64k context-full budget and must stay stable across
		// catalog regenerations.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		// Seed a minimal session branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"todo.reminders": true,
				"todo.remindersMax": 3,
			}),
			modelRegistry,
			extensionRunner,
		});
	}

	beforeEach(async () => {
		vi.useFakeTimers();
		await setupSession();
	});

	function triggerThresholdAutoCompaction(): void {
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
	}

	function observeAutoCompactionEnd(): Promise<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> {
		const { promise, resolve } = Promise.withResolvers<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") resolve(event);
		});
		return promise;
	}

	async function waitForFakeTimerBounded<T>(event: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		let settled = false;
		void event.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const observed = withTimeout(event, timeoutMs, message);
		const timerStepMs = 10;
		for (let elapsed = 0; elapsed < timeoutMs && !settled; elapsed += timerStepMs) {
			for (let flush = 0; flush < 10 && !settled; flush++) await Promise.resolve();
			if (!settled) vi.advanceTimersByTime(Math.min(timerStepMs, timeoutMs - elapsed));
		}
		for (let flush = 0; flush < 10 && !settled; flush++) await Promise.resolve();
		return observed;
	}

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			try {
				vi.useRealTimers();
				await Bun.sleep(0);
			} finally {
				getRuntimeSignals().length = 0;
				const runtimeGlobal = globalThis as RuntimeSignalGlobal;
				runtimeGlobal.__ompManualCompactGate = undefined;
				runtimeGlobal.__ompPrecommitGate = undefined;
				runtimeGlobal.__ompPrecommitResult = undefined;
				runtimeGlobal.__ompPrecommitError = undefined;
				runtimeGlobal.__ompPrecommitEntered = undefined;
				runtimeGlobal.__ompPrecommitFollower = undefined;
				runtimeGlobal.__ompCompactionDetails = undefined;
				runtimeGlobal.__ompCompactionPreserveData = undefined;
				runtimeGlobal.__ompPrecommitMutation = undefined;
				testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
				vi.restoreAllMocks();
			}
		}
	});
	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			// Real continue() polls and consumes the queued steering/follow-up
			// messages. Mirror that here so the stranded-queue drain settles after
			// one resume instead of rescheduling itself forever (a no-op mock
			// leaves the queue populated, spinning the drain into an OOM loop).
			session.agent.clearAllQueues();
		});

		// The continuation is already scheduled when the public agent_end arrives,
		// so consumers must see it as a non-terminal scheduling pause.
		const agentEndTerminalStates: Array<boolean | undefined> = [];
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_compaction_end") onCompactionDone();
			if (event.type === "agent_end") agentEndTerminalStates.push(event.isTerminal);
		});

		// Build a fake AssistantMessage with high token usage to trigger threshold
		// compaction (contextWindow=200000, threshold ~80%).
		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: an empty `stop` turn would trip the empty-stop guard
			// (#handleEmptyAssistantStop) and short-circuit the agent_end handler before
			// compaction/todo checks run — hanging this test forever under fake timers.
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		// Drive auto-compaction through the event flow:
		// message_end → stores #lastAssistantMessage
		// agent_end   → #checkCompaction → shouldCompact → #runAutoCompaction
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		// Wait for compaction completion, then verify waitForIdle blocks on queued continuation.
		await compactionDone;
		await Promise.resolve();
		const idlePromise = session.waitForIdle();
		let idleResolved = false;
		void idlePromise.then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);
		vi.advanceTimersByTime(200);
		await idlePromise;

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
		expect(agentEndTerminalStates).toEqual([false]);
	});

	it("marks manual compaction active before abort teardown can yield", async () => {
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "second turn",
			timestamp: Date.now(),
		});

		const abortEntered = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		let compactingDuringAbort: boolean | undefined;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			compactingDuringAbort = session.isCompacting;
			abortEntered.resolve();
			await releaseAbort.promise;
		});

		const compactPromise = session.compact();
		await abortEntered.promise;
		releaseAbort.resolve();
		await compactPromise;

		expect(compactingDuringAbort).toBe(true);
	});

	it("resumes a message queued during manual compaction once it completes (#5800)", async () => {
		// Regression for #5800 review: manual /compact disconnects the agent
		// listener before `await abort()`, so the abort-finally stranded-message
		// drain is suppressed while disconnected. Unlike /new (which resets the
		// queue), compaction preserves the agent queues, so a steer/follow-up that
		// arrives mid-compaction (async IRC, an xd:// mount notice, an SDK steer)
		// would hang until the next explicit prompt unless compact() re-drains
		// after reconnecting.
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		// Park compaction inside its awaited hook so we can queue a follow-up while
		// the session is disconnected and abort has already run its finally.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;

		const compactPromise = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		// A message arrives DURING compaction (post-abort, still disconnected).
		session.agent.followUp({
			role: "user",
			content: "please respond after compaction",
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		gate.resolve();
		await compactPromise;
		await session.waitForIdle();

		// compact()'s finally re-drained the stranded queue after reconnecting.
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("cancels an in-flight auto-compaction when manual compact startup aborts", async () => {
		// Give the branch something to summarize so auto-compaction reaches the
		// awaited session_before_compact hook, where the test parks it.
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });

		// Park the in-flight auto-compaction inside its awaited hook so
		// #autoCompactionAbortController stays installed across the manual /compact
		// startup abort below.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;

		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		let autoAborted: boolean | undefined;
		const autoEnded = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				autoAborted = event.aborted;
				autoEnded.resolve();
			}
		});

		const autoPromise = session.runIdleCompaction();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		// Manual /compact startup performs exactly this internal abort while holding
		// its own freshly installed #compactionAbortController. The auto signal is
		// raised synchronously (before abort's first await), then the gate releases
		// the parked pass so it observes the abort and unwinds.
		const abortPromise = session.abort({ goalReason: "internal", preserveCompaction: true });
		gate.resolve();
		await abortPromise;
		await autoPromise;
		await autoEnded.promise;

		// The in-flight auto pass MUST be cancelled so it cannot race the manual run
		// and double-rewrite session history.
		expect(autoAborted).toBe(true);
		expect(appendCompactionSpy).not.toHaveBeenCalled();
	});

	it("runs threshold compaction for active goal turns that end with yield", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield",
			name: "yield",
			arguments: { status: "progress" },
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});

	it("runs active-goal threshold compaction after yield followed by a trailing empty stop", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-yield-empty-stop-threshold",
				objective: "continue after compacting",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield_then_empty",
			name: "yield",
			arguments: { status: "progress" },
		};
		const yieldMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		const trailingEmptyStop = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 191000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now + 1,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: yieldMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "message_end", message: trailingEmptyStop });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [yieldMsg, trailingEmptyStop] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
		expect(
			debugSpy.mock.calls.some(([message, context]) => {
				if (message !== "agent_end maintenance routing") return false;
				if (context?.route !== "post-yield-trailing-stop-active-goal-checkCompaction") return false;
				return context.successfulYield === true;
			}),
		).toBe(true);
	});

	it("triggers threshold compaction in active goals even when per-turn pruning shaves the post-prune estimate below threshold", async () => {
		// Regression for #3174. Goal mode is the most common scenario: the agent
		// runs many tool-result-heavy turns and the per-turn "useless" /
		// "supersede" passes shave tokens off every check. Pre-fix
		// `#checkCompaction` subtracted those savings from the threshold input, so
		// with the reporter's fixed `compaction.thresholdTokens: 76384`, the
		// threshold input fell below the trigger even when the provider-billed
		// prompt (and the visible context anchored to it) sat above 90k tokens —
		// auto-compaction silently no-op'd indefinitely while the loop kept
		// running.
		//
		// This seeds one large `useless` tool result whose suffix sits inside the
		// 8k cache-warm window so `#pruneStaleToolResults` actually returns ≥20k
		// savings (well above the buggy code's mis-subtraction needed to drop
		// 91000 below 76384). Compaction MUST still fire because the last turn's
		// billed context tokens (91k) are above the configured threshold.
		const now = Date.now();

		// Seed: small user, small toolCall, ONE big useless tool result, then a
		// handful of small turns that keep the suffix after the big result under
		// the 8000-token cache-warm cutoff. The big result is the only viable
		// prune candidate, and it alone saves well over 20k tokens — enough to
		// drag the pre-fix threshold input from 91k well below 76384.
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
		const bigCallId = "call-big-useless";
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 180,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: bigCallId,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }], // ~40k+ tokens
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		// A few small follow-up turns so the big result's suffix stays inside the
		// 8000-token cache-warm window. Each pair is well under a hundred tokens.
		for (let i = 0; i < 4; i++) {
			const smallId = `call-small-${i}`;
			const ts = now - 160 + i * 2;
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: smallId, name: "read", arguments: { path: `note-${i}.md` } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: ts,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: smallId,
				toolName: "read",
				content: [{ type: "text", text: `tiny note ${i}` }],
				isError: false,
				timestamp: ts + 1,
			});
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-threshold-pruneable",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.strategy", "context-full");
		session.settings.set("compaction.dropUseless", true);
		session.settings.set("compaction.supersedeReads", true);
		session.settings.set("compaction.keepRecentTokens", 10000);
		session.settings.set("compaction.reserveTokens", 16384);

		// Final assistant turn: billed at ~91k context tokens, just over the
		// reporter's threshold. The pre-fix code would have subtracted ≥20k of
		// prune savings and dropped the threshold input below 76384, skipping
		// compaction. Post-fix it must trigger.
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Investigated module-7; continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});
	it("runs active-goal threshold compaction before unexpected-stop retry continuation", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-unexpected-stop-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("features.unexpectedStopDetection", true);
		session.settings.set("providers.unexpectedStopModel", "online");

		vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I should continue investigating another module." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
	});

	it("resolves a pending retry before active-goal compaction continuation returns", async () => {
		// Codex review on #3175: a retry can succeed with a non-empty text stop
		// that is already over the active-goal compaction threshold. If the
		// compaction pre-empt schedules its own continuation before the normal
		// bottom-of-handler `#resolveRetry()` call runs, the session stays
		// `isRetrying` and later prompt/idle gates remain blocked.
		vi.useRealTimers();
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-retry-threshold",
				objective: "recover from retry and compact",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("retry.enabled", true);
		session.settings.set("retry.baseDelayMs", 5);
		session.settings.set("retry.maxDelayMs", 5_000);
		session.settings.set("retry.maxRetries", 1);
		session.settings.set("retry.modelFallback", false);

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const { promise: retryStarted, resolve: onRetryStarted } = Promise.withResolvers<void>();
		const { promise: retryEnded, resolve: onRetryEnded } = Promise.withResolvers<void>();
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_retry_start") onRetryStarted();
			if (event.type === "auto_retry_end") onRetryEnded();
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const retryableError = {
			role: "assistant" as const,
			// Thinking-only partial: a committed visible text block would classify the
			// failed turn as replay-unsafe and suppress the retry this test depends on.
			content: [{ type: "thinking" as const, thinking: "Transient provider failure." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "503 service unavailable: overloaded_error retry-after-ms=50",
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 1,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: retryableError });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [retryableError] });

		await withTimeout(retryStarted, 1000, "Retry start timed out");
		expect(session.isRetrying).toBe(true);

		const recoveredOverThreshold = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Recovered; continuing the active goal." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: recoveredOverThreshold });
		await withTimeout(retryEnded, 1000, "Retry end timed out");
		expect(session.isRetrying).toBe(true);

		session.agent.emitExternalEvent({ type: "agent_end", messages: [recoveredOverThreshold] });

		await withTimeout(compactionDone, 1000, "Compaction end timed out");
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(session.isRetrying).toBe(false);
	});

	it("removes orphan toolUse assistant before active-goal threshold compaction continuation", async () => {
		// Codex review on #3175: when an active goal turn is over threshold AND
		// stops with an empty `toolUse` (no tool call), the new ordering must NOT
		// skip `#handleEmptyAssistantStop` — that handler is the only path that
		// strips the orphan assistant from active context + session history. If a
		// compaction continuation runs with the orphan still in place, the next
		// Anthropic turn carries a `tool_use` block with no matching
		// `tool_result` and corrupts the message history.
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-orphan-toolUse-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("contextPromotion.enabled", false);

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const orphanToolUse = {
			role: "assistant" as const,
			// Empty toolUse stop: stopReason says a tool was requested but the
			// content block is empty (no toolCall). This is the case the empty-stop
			// cleanup defends against.
			content: [] as never[],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: orphanToolUse });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [orphanToolUse] });

		await session.waitForIdle();

		// Empty-stop cleanup short-circuits before any compaction continuation, so
		// the threshold compaction MUST NOT fire on this turn — the next turn
		// starts from the cleaned-up branch with the retry-reminder developer
		// message instead. The pre-fix ordering let compaction reach
		// `auto_compaction_start` first, scheduling a continuation while the
		// orphan `toolUse` entry was still the session leaf.
		const signals = getRuntimeSignals();
		expect(signals).not.toContain("compaction:start:threshold");

		// `#removeEmptyStopFromActiveContext` rewinds the session leaf past the
		// orphan via `sessionManager.branch(parentId)` / `resetLeaf()`. If the
		// cleanup is skipped, the orphan is still the leaf when the compaction
		// continuation runs and the next Anthropic turn sends a `tool_use` block
		// with no matching `tool_result`.
		const branch = sessionManager.getBranch();
		const orphanInBranch = branch.some(entry => {
			if (entry.type !== "message") return false;
			const message = entry.message as { role: string; stopReason?: string };
			return message.role === "assistant" && message.stopReason === "toolUse";
		});
		expect(orphanInBranch).toBe(false);
	});

	it("has isCompacting true when the auto_compaction_start event fires", async () => {
		// Defect 1: the compaction AbortController (which backs isCompacting) must be
		// installed before auto_compaction_start is emitted. If it is installed after,
		// a message typed the instant the loader appears is read while
		// isCompacting === false and mis-routed into the core steering queue (which a
		// later handoff reset would wipe) instead of the safe UI compaction queue.
		let capturedIsCompacting: boolean | undefined;
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") {
				capturedIsCompacting = session.isCompacting;
			} else if (event.type === "auto_compaction_end") {
				onCompactionDone();
			}
		});

		// Defensive: mirror the resume-drain stub so any queued continuation settles
		// instead of spinning the drain (see the threshold test above).
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;

		expect(capturedIsCompacting).toBe(true);
	});

	it("awaits automatic precommit before appending or replacing compaction context", async () => {
		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		const replaceMessagesSpy = vi.spyOn(session.agent, "replaceMessages");
		const precommitGate = Promise.withResolvers<void>();
		const precommitEntered = Promise.withResolvers<SessionCompactionPrecommitEvent>();
		const runtimeGlobal = globalThis as RuntimeSignalGlobal;
		runtimeGlobal.__ompPrecommitGate = precommitGate.promise;
		runtimeGlobal.__ompPrecommitEntered = precommitEntered.resolve;
		const compactionEnd = observeAutoCompactionEnd();

		triggerThresholdAutoCompaction();
		const event = await waitForFakeTimerBounded(precommitEntered.promise, 1000, "Precommit event timed out");

		try {
			expect(event).toMatchObject({
				type: "session_compaction_precommit",
				trigger: "auto",
				reason: "threshold",
				action: "context-full",
				automatic: true,
				autoCompactionIteration: 1,
				compaction: { summary: "compacted", details: {} },
			});
			expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
			expect(event.customInstructions).toBeUndefined();
			expect(event.signal.aborted).toBe(false);
			expect(appendCompactionSpy).not.toHaveBeenCalled();
			expect(replaceMessagesSpy).not.toHaveBeenCalled();
			expect(getRuntimeSignals()).toContain("compaction:precommit:threshold");
			expect(getRuntimeSignals()).not.toContain("compaction:post");
		} finally {
			precommitGate.resolve();
		}
		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "Auto-compaction end timed out");
		expect(end.aborted).toBe(false);
		expect(end.result).toBe(event.compaction);
		expect(getRuntimeSignals().filter(signal => signal === "compaction:precommit:threshold")).toHaveLength(1);
		expect(appendCompactionSpy).toHaveBeenCalledTimes(1);
		expect(replaceMessagesSpy).toHaveBeenCalledTimes(1);
	});

	it("emits automatic precommit before session_compact after a successful commit", async () => {
		const compactionEnd = observeAutoCompactionEnd();

		triggerThresholdAutoCompaction();

		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "Auto-compaction end timed out");
		const signals = getRuntimeSignals();
		const precommitIndex = signals.indexOf("compaction:precommit:threshold");
		const postCommitIndex = signals.indexOf("compaction:post");

		expect(end.aborted).toBe(false);
		expect(precommitIndex).toBeGreaterThanOrEqual(0);
		expect(postCommitIndex).toBeGreaterThan(precommitIndex);
		expect(signals.filter(signal => signal === "compaction:precommit:threshold")).toHaveLength(1);
	});

	it("fails closed when automatic precommit explicitly cancels", async () => {
		const branchBefore = sessionManager.getBranch();
		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		const replaceMessagesSpy = vi.spyOn(session.agent, "replaceMessages");
		const runtimeGlobal = globalThis as RuntimeSignalGlobal;
		const follower = vi.fn();
		runtimeGlobal.__ompPrecommitFollower = follower;
		runtimeGlobal.__ompPrecommitResult = { cancel: true, reason: "test cancellation" };
		const compactionEnd = observeAutoCompactionEnd();

		triggerThresholdAutoCompaction();

		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "Cancelled auto-compaction end timed out");
		expect(end).toMatchObject({ aborted: true, result: undefined });
		expect(appendCompactionSpy).not.toHaveBeenCalled();
		expect(replaceMessagesSpy).not.toHaveBeenCalled();
		const branchAfter = sessionManager.getBranch();
		expect(branchAfter.slice(0, branchBefore.length)).toEqual(branchBefore);
		expect(branchAfter).toHaveLength(branchBefore.length + 1);
		expect(branchAfter.some(entry => entry.type === "compaction")).toBe(false);
		expect(follower).toHaveBeenCalledTimes(1);
		expect(getRuntimeSignals()).toContain("compaction:precommit:threshold");
		expect(end.errorMessage).toBe("test cancellation");
		expect(getRuntimeSignals()).not.toContain("compaction:post");
	});

	it("fails closed when an automatic precommit handler throws", async () => {
		const branchBefore = sessionManager.getBranch();
		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		const replaceMessagesSpy = vi.spyOn(session.agent, "replaceMessages");
		const runtimeGlobal = globalThis as RuntimeSignalGlobal;
		const follower = vi.fn();
		runtimeGlobal.__ompPrecommitFollower = follower;
		runtimeGlobal.__ompPrecommitError = new Error("precommit fixture failure");
		const compactionEnd = observeAutoCompactionEnd();

		triggerThresholdAutoCompaction();

		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "Failed auto-compaction end timed out");
		expect(end).toMatchObject({
			aborted: true,
			result: undefined,
			errorMessage: "compaction precommit handler error: precommit fixture failure",
		});
		expect(appendCompactionSpy).not.toHaveBeenCalled();
		expect(replaceMessagesSpy).not.toHaveBeenCalled();
		const branchAfter = sessionManager.getBranch();
		expect(branchAfter.slice(0, branchBefore.length)).toEqual(branchBefore);
		expect(branchAfter).toHaveLength(branchBefore.length + 1);
		expect(branchAfter.some(entry => entry.type === "compaction")).toBe(false);
		expect(follower).toHaveBeenCalledTimes(1);
		expect(reportedExtensionErrors).toContainEqual({
			event: "session_compaction_precommit",
			error: "precommit fixture failure",
		});
		expect(getRuntimeSignals()).toContain("compaction:precommit:threshold");
		expect(getRuntimeSignals()).not.toContain("compaction:post");
	});

	it("fails closed on precommit timeout, reports the error, and still settles later listeners", async () => {
		const branchBefore = sessionManager.getBranch();
		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		const replaceMessagesSpy = vi.spyOn(session.agent, "replaceMessages");
		const runtimeGlobal = globalThis as RuntimeSignalGlobal;
		const follower = vi.fn();
		testSetExtensionHandlerTimeoutMs(20);
		runtimeGlobal.__ompPrecommitFollower = follower;
		runtimeGlobal.__ompPrecommitGate = new Promise<void>(() => {});
		const compactionEnd = observeAutoCompactionEnd();

		triggerThresholdAutoCompaction();

		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "Timed-out auto-compaction end timed out");
		expect(end).toMatchObject({
			aborted: true,
			result: undefined,
			errorMessage: "compaction precommit handler timeout: handler timed out after 20ms",
		});
		expect(appendCompactionSpy).not.toHaveBeenCalled();
		expect(replaceMessagesSpy).not.toHaveBeenCalled();
		const branchAfter = sessionManager.getBranch();
		expect(branchAfter.slice(0, branchBefore.length)).toEqual(branchBefore);
		expect(branchAfter).toHaveLength(branchBefore.length + 1);
		expect(branchAfter.some(entry => entry.type === "compaction")).toBe(false);
		expect(follower).toHaveBeenCalledTimes(1);
		expect(reportedExtensionErrors).toContainEqual({
			event: "session_compaction_precommit",
			error: "handler timed out after 20ms",
		});
		expect(getRuntimeSignals()).not.toContain("compaction:post");
	});

	it("appends the original unfrozen candidate without precommit handlers", async () => {
		const details = { files: { read: ["src/a.ts"] } };
		const preserveData = { audit: { marker: "kept" } };

		await session.dispose();
		await setupSession(false);

		const emitSpy = vi.spyOn(extensionRunner, "emit");
		const runtimeGlobal = globalThis as RuntimeSignalGlobal;
		runtimeGlobal.__ompCompactionDetails = details;
		runtimeGlobal.__ompCompactionPreserveData = preserveData;
		const compactionEnd = observeAutoCompactionEnd();

		expect(extensionRunner.hasHandlers("session_compaction_precommit")).toBe(false);
		triggerThresholdAutoCompaction();

		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "No-handler auto-compaction end timed out");
		const persisted = sessionManager
			.getBranch()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction")
			.at(-1);

		expect(emitSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session_compaction_precommit" }));
		expect(getRuntimeSignals()).not.toContain("compaction:precommit:threshold");
		expect(Object.isFrozen(details)).toBe(false);
		expect(Object.isFrozen(details.files)).toBe(false);
		expect(Object.isFrozen(preserveData)).toBe(false);
		expect(Object.isFrozen(preserveData.audit)).toBe(false);
		expect(persisted).toMatchObject({
			summary: "compacted",
			details,
			preserveData,
		});
		expect(persisted?.details).toBe(details);
		expect(persisted?.preserveData).toBe(preserveData);
		expect(end).toMatchObject({
			action: "context-full",
			aborted: false,
			result: { details, preserveData },
		});
	});

	it("freezes one exact snapcompact proposal and strips only the post-commit end projection", async () => {
		const details = { files: { read: ["src/a.ts"] } };
		const preserveData = {
			snapcompact: {
				frames: [{ data: "frame-1", mimeType: "image/png", cols: 4, rows: 2, chars: 8 }],
				text: "archived conversation",
				totalChars: 21,
				truncatedChars: 0,
			},
			audit: { marker: "kept" },
		};
		const runtimeGlobal = globalThis as RuntimeSignalGlobal;
		const { promise: precommitEntered, resolve: onPrecommitEntered } =
			Promise.withResolvers<SessionCompactionPrecommitEvent>();
		let followerEvent: SessionCompactionPrecommitEvent | undefined;
		let blockedMutations = 0;
		runtimeGlobal.__ompCompactionDetails = details;
		runtimeGlobal.__ompCompactionPreserveData = preserveData;
		runtimeGlobal.__ompPrecommitEntered = onPrecommitEntered;
		runtimeGlobal.__ompPrecommitFollower = event => {
			followerEvent = event;
		};
		runtimeGlobal.__ompPrecommitMutation = event => {
			// The listener intentionally violates the public readonly contract to
			// prove the runtime boundary protects later listeners and persistence.
			const mutableEvent = event as unknown as { timestamp: string; autoCompactionIteration: number };
			const mutableDetails = event.compaction.details as { files: { read: string[] } };
			const mutablePreserveData = event.compaction.preserveData as typeof preserveData;
			const mutations = [
				() => {
					mutableEvent.timestamp = "mutated";
				},
				() => {
					mutableEvent.autoCompactionIteration = 99;
				},
				() => {
					mutableDetails.files.read[0] = "mutated.ts";
				},
				() => {
					mutablePreserveData.snapcompact.frames[0].data = "mutated-frame";
				},
			];
			for (const mutate of mutations) {
				try {
					mutate();
				} catch {
					blockedMutations++;
				}
			}
		};
		session.agent.setModel({ ...session.agent.state.model, input: ["text", "image"] });
		session.settings.override("compaction.strategy", "snapcompact");
		const compactionEnd = observeAutoCompactionEnd();

		triggerThresholdAutoCompaction();

		const proposal = await waitForFakeTimerBounded(precommitEntered, 1000, "Snapcompact precommit timed out");
		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "Snapcompact end timed out");
		const persisted = sessionManager
			.getBranch()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction")
			.at(-1);

		expect(blockedMutations).toBe(4);
		expect(Object.isFrozen(proposal)).toBe(true);
		expect(Object.isFrozen(proposal.compaction)).toBe(true);
		expect(Object.isFrozen(proposal.compaction.details)).toBe(true);
		expect(Object.isFrozen(proposal.compaction.preserveData?.snapcompact)).toBe(true);
		expect(followerEvent).toBe(proposal);
		expect(followerEvent?.compaction).toBe(proposal.compaction);
		expect(proposal.action).toBe("snapcompact");
		expect(proposal.compaction.details).toEqual(details);
		expect(proposal.compaction.preserveData).toEqual(preserveData);
		expect(persisted).toMatchObject(proposal.compaction);
		expect(persisted?.details).toBe(proposal.compaction.details);
		expect(persisted?.preserveData).toBe(proposal.compaction.preserveData);
		expect(end).toMatchObject({
			action: "snapcompact",
			aborted: false,
			result: { preserveData: { audit: { marker: "kept" } } },
		});
		expect(end.result).not.toBe(proposal.compaction);
	});

	it("does not advertise automatic shake maintenance as a compaction precommit", async () => {
		const precommit = vi.fn();
		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		const runtimeGlobal = globalThis as RuntimeSignalGlobal;
		runtimeGlobal.__ompPrecommitEntered = precommit;
		session.settings.override("compaction.strategy", "shake");
		vi.spyOn(session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 1,
			blocksDropped: 0,
			tokensFreed: 100_000,
		});
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200_000, percent: 0.5 });
		const compactionEnd = observeAutoCompactionEnd();

		triggerThresholdAutoCompaction();

		const end = await waitForFakeTimerBounded(compactionEnd, 1000, "Auto-shake end timed out");
		expect(end).toMatchObject({ action: "shake", result: undefined, aborted: false });
		expect(precommit).not.toHaveBeenCalled();
		expect(appendCompactionSpy).not.toHaveBeenCalled();
	});

	it("forwards todo reminder lifecycle signals to extensions", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "Finish pending task", status: "in_progress" }],
			},
		]);

		const { promise: reminderDone, resolve: onReminderDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "todo_reminder") onReminderDone();
		});

		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: see comment on the first test's assistantMsg.
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(reminderDone, 1000, "Todo reminder timed out");
		await Promise.resolve();

		expect(getRuntimeSignals()).toContain("todo:1/3");
		expect(continueSpy).toHaveBeenCalledTimes(1);
		await session.waitForIdle();
	});
});
