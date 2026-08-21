import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveRuntimeSoftPhase, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contract: `task.maxRuntimeMs` must give a *live* subagent the same wrap-up
 * ladder the soft request budget already gives it — a steering notice, then a
 * forced final `yield` — so its findings reach the parent as a submitted
 * report instead of being lost to the hard abort at the deadline.
 *
 * The hard abort itself is unchanged and is covered by
 * `executor-wall-clock.test.ts`: a child that has stopped emitting assistant
 * messages (the provider-hang case) crosses no soft threshold and is still
 * killed on the timer.
 *
 * Real timers, deliberately: the thing under test is the interleaving of the
 * executor's own `setTimeout(maxRuntimeMs)` with message-boundary threshold
 * checks. Fake timers would let the test dictate that ordering.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface MockSessionHandle {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	steers: string[];
	abortCalls: () => number;
}

function assistantText(text: string, stopReason: "stop" | "aborted" = "stop") {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason };
}

function yieldMessage(report: string) {
	return {
		role: "assistant" as const,
		content: [
			{
				type: "toolCall" as const,
				id: "tool-forced-yield",
				name: "yield",
				arguments: { result: { data: { report } } },
			},
		],
		stopReason: "toolUse" as const,
	};
}

function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
		aborted: () => boolean;
		abortCount: () => number;
	}) => void | Promise<void>,
): MockSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	const steers: string[] = [];
	let abortCount = 0;
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			prompts.push({ text, options });
			await onPrompt({
				promptIndex,
				emit,
				pushMessage: message => messages.push(message),
				aborted: () => abortCount > 0,
				abortCount: () => abortCount,
			});
			return true;
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async (text: string) => {
			steers.push(text);
		},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
		abort: async () => {
			abortCount += 1;
		},
		dispose: async () => {},
	};

	return {
		session: session as AgentSession,
		prompts,
		steers,
		abortCalls: () => abortCount,
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess wall-clock soft phase (task.maxRuntimeMs)", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@pi-runtime-soft-phase-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir[Symbol.dispose]();
	});

	// maxRuntimeMs=4000 → notice at 1000 ms elapsed, forced stop at 2000 ms,
	// hard abort at 4000 ms (see resolveRuntimeSoftPhase: short caps collapse to
	// the 0.75 / 0.5 ceilings). The margins are deliberately wide: elapsed is
	// measured from monitor creation, so session setup eats into the notice
	// window, and a loaded CI box must not miss it.
	function baseOptions(id: string, overrides: Record<string, unknown> = {}) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "do long work",
			index: 0,
			id,
			settings: Settings.isolated({ "task.maxRuntimeMs": 4000, ...overrides }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
		};
	}

	/** Emit an assistant message every 100 ms until the executor stops the turn. */
	async function workUntilStopped(params: {
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
		aborted: () => boolean;
		budgetMs: number;
	}) {
		const startedAt = Date.now();
		for (let i = 1; !params.aborted() && Date.now() - startedAt < params.budgetMs; i++) {
			const message = assistantText(`working ${i}`);
			params.pushMessage(message);
			params.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			await sleep(100);
		}
	}

	it("warns a live subagent before the deadline and forces it to submit its report", async () => {
		const id = "RuntimeScout";
		let steersAtReminder: string[] = [];
		let abortCallsAtReminder: number | undefined;
		const handle = createMockSession(async ({ promptIndex, emit, pushMessage, aborted }) => {
			if (promptIndex === 1) {
				await workUntilStopped({ emit, pushMessage, aborted, budgetMs: 3800 });
				return;
			}
			// The forced wrap-up reminder: answer it with a terminal yield.
			steersAtReminder = [...handle.steers];
			abortCallsAtReminder = handle.abortCalls();
			const message = yieldMessage("partial findings");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-forced-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "partial findings" } },
				},
				isError: false,
			} as AgentSessionEvent);
		});
		mockCreateAgentSession(handle.session);

		const startedAt = Date.now();
		const result = await runSubprocess(baseOptions(id));
		const elapsedMs = Date.now() - startedAt;

		// 1. The child was warned while it could still act on the warning.
		expect(steersAtReminder.some(text => text.includes("[runtime notice]"))).toBe(true);
		expect(steersAtReminder.some(text => text.includes("task.maxRuntimeMs"))).toBe(true);
		// 2. Exactly one soft stop ended the free-running turn before the reminder.
		expect(abortCallsAtReminder).toBe(1);
		// 3. The forced yield reached the parent as a real report, and the run is
		//    a normal completion — not an abort the caller has to go excavate.
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.extractedToolData?.yield).toBeDefined();
		expect(JSON.stringify(result.extractedToolData?.yield)).toContain("partial findings");
		// 4. It finished inside the wall-clock budget rather than on the timer.
		expect(elapsedMs).toBeLessThan(4000);
	});

	it("still forces the yield when the notice is disabled", async () => {
		const id = "RuntimeScoutQuiet";
		let steersAtReminder: string[] = [];
		const handle = createMockSession(async ({ promptIndex, emit, pushMessage, aborted }) => {
			if (promptIndex === 1) {
				await workUntilStopped({ emit, pushMessage, aborted, budgetMs: 3800 });
				return;
			}
			steersAtReminder = [...handle.steers];
			const message = yieldMessage("quiet findings");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-forced-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "quiet findings" } },
				},
				isError: false,
			} as AgentSessionEvent);
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess(baseOptions(id, { "task.maxRuntimeNotice": false }));

		expect(steersAtReminder).toEqual([]);
		expect(result.aborted).toBe(false);
		expect(result.extractedToolData?.yield).toBeDefined();
	});

	it("reports a runtime soft stop the child never answered as a wall-clock stop", async () => {
		const id = "RuntimeScoutStubborn";
		const handle = createMockSession(async ({ emit, pushMessage, aborted }) => {
			// The child never yields. `aborted()` stays true once the soft stop
			// fires, so the forced reminder turn returns at once and the run
			// finalizes through the no-yield soft-stop path — before the timer.
			await workUntilStopped({ emit, pushMessage, aborted, budgetMs: 5000 });
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess(baseOptions(id));

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		// Symmetric with the request budget's own force-stop reason: the parent is
		// told which limit ended the run, not a generic missing-yield failure.
		expect(result.abortReason).toContain("wall-clock soft phase reached");
		expect(result.abortReason).toContain("task.maxRuntimeMs=4000");
	});

	it("still hard-aborts a child that keeps working straight past the deadline", async () => {
		const id = "RuntimeScoutRunaway";
		const handle = createMockSession(async ({ emit, pushMessage, abortCount }) => {
			// Ignore the soft stop: keep emitting past it, so only the timer at
			// 4000 ms can end this run. Each turn tolerates the aborts it started
			// with and stops only when a *new* one lands.
			const abortsAtTurnStart = abortCount();
			const startedAt = Date.now();
			for (let i = 1; abortCount() <= abortsAtTurnStart && Date.now() - startedAt < 6000; i++) {
				const message = assistantText(`ignoring the stop ${i}`);
				pushMessage(message);
				emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				await sleep(100);
			}
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess(baseOptions(id));

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("Subagent runtime limit exceeded");
		expect(result.abortReason).toContain("task.maxRuntimeMs=4000");
	});

	it("never soft-stops a child that has stopped producing messages", async () => {
		const id = "RuntimeScoutHung";
		// The provider-hang case `maxRuntimeMs` exists for: no assistant message
		// ever lands, so neither ladder is evaluated and the run dies on the
		// timer exactly as it did before the soft phase existed.
		const handle = createMockSession(async () => {
			await sleep(5000);
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess(baseOptions(id, { "task.maxRuntimeMs": 1500 }));

		expect(handle.steers).toEqual([]);
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("Subagent runtime limit exceeded (task.maxRuntimeMs=1500)");
	});
});

describe("resolveRuntimeSoftPhase", () => {
	it("is disabled when the wall-clock cap is", () => {
		expect(resolveRuntimeSoftPhase(0)).toBeUndefined();
		expect(resolveRuntimeSoftPhase(-1)).toBeUndefined();
	});

	it("keeps both thresholds inside the run for long caps", () => {
		// 1 hour: the fractional windows (25 % notice / 10 % stop) exceed the
		// 30 s / 15 s floors, so they set the thresholds.
		const phase = resolveRuntimeSoftPhase(3_600_000);
		expect(phase).toEqual({ noticeAtMs: 2_700_000, stopAtMs: 3_240_000 });
	});

	it("collapses proportionally for short caps instead of switching off", () => {
		// 10 s: the fixed windows would swallow the whole run, so the fractional
		// ceilings (0.75 / 0.5) apply and the ordering notice → stop → deadline
		// is preserved.
		const phase = resolveRuntimeSoftPhase(10_000);
		expect(phase).toEqual({ noticeAtMs: 2_500, stopAtMs: 5_000 });
	});
});
