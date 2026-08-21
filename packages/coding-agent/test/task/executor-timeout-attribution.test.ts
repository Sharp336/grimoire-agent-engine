import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/**
 * Regression for two defects that shared one root cause (#9191):
 * `requestAbort` wrote `runtimeLimitExceeded` / `budgetLimitExceeded` ABOVE
 * the `abortSent` / `resolved` guards, and `resolveAbortReasonText` reads
 * those raw flags with top priority. A wall-clock timer that fires after the
 * run's real outcome is already decided therefore rewrote that outcome.
 *
 * Real timers, deliberately: the defect IS the interleaving between the
 * executor's real `setTimeout(maxRuntimeMs)` and its real async teardown.
 * Fake timers would let the test dictate that ordering instead of observing
 * it, which is the thing under test. Matches `executor-wall-clock.test.ts`.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-attribution",
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("wall-clock abort attribution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("BUG 1: a budget hard-abort is reported as a runtime-limit kill when the timer fires during teardown", async () => {
		// softRequestBudget=1 -> stop at 1.5 requests, hard abort at 1.5+5.
		// The child burns 8 requests immediately, so the budget kills it at t~0.
		// maxRuntimeMs=400 fires later, while the session teardown is still in
		// flight (abort() below holds the run open for 1500ms). The margins are
		// wide on purpose: a loaded CI core must not reorder the two events.
		const settings = Settings.isolated({
			"task.softRequestBudget": 1,
			"task.maxRuntimeMs": 400,
		});

		const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let abortCount = 0;

		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			hasPendingAsyncWork: () => false,
			prompt: async (_text: string, _options?: PromptOptions) => {
				for (let i = 0; i < 8; i++) {
					listenerRef?.({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: `step ${i}` }] },
					} as unknown as AgentSessionEvent);
				}
				await hang;
				return true;
			},
			waitForIdle: async () => {
				await hang;
			},
			getLastAssistantMessage: () => undefined,
			abort: async () => {
				abortCount += 1;
				// Teardown is slow enough that the wall-clock timer fires while
				// the budget abort is still settling.
				await sleep(1500);
				releaseHang();
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-budget-then-timer", settings });

		expect(abortCount).toBeGreaterThanOrEqual(1);
		expect(result.aborted).toBe(true);
		// The run was killed by the request budget. That is what the parent must
		// be told, so it lowers the task size / raises the budget - not the clock.
		expect(result.abortReason).toContain("Soft request budget exceeded");
		expect(result.abortReason).not.toContain("runtime limit exceeded");
	});

	it("BUG 2: a complete pre-deadline yield is reported as an aborted timeout", async () => {
		// The child yields a full report at t~0, well inside the 400ms budget.
		// Post-yield teardown (quiescence barrier, artifact writes) then runs
		// past the deadline. The report is intact but the run is tagged aborted.
		const settings = Settings.isolated({ "task.maxRuntimeMs": 400 });

		let listenerRef: ((event: AgentSessionEvent) => void) | undefined;
		let abortCount = 0;

		const session: Partial<AgentSession> = {
			setIrcWakeTurnObserver: () => {},
			subscribeRunState: () => () => {},
			state: { messages: [] } as never,
			agent: { state: { systemPrompt: ["test"] } } as never,
			extensionRunner: undefined as never,
			sessionManager: { appendSessionInit: () => {} } as never,
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			setActiveToolsByName: async () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listenerRef = listener;
				return () => {};
			},
			hasPendingAsyncWork: () => false,
			prompt: async (_text: string, _options?: PromptOptions) => {
				listenerRef?.({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { finding: "complete report" } },
					},
					isError: false,
				} as AgentSessionEvent);
				return true;
			},
			waitForIdle: async () => {},
			getLastAssistantMessage: () => undefined,
			// Post-yield session teardown outlives the remaining wall-clock slack.
			abort: async () => {
				abortCount += 1;
				await sleep(1500);
			},
			dispose: async () => {},
		};
		mockCreateAgentSession(session as AgentSession);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-yield-then-timer", settings });

		expect(abortCount).toBeGreaterThanOrEqual(1);
		// The child submitted its result before the deadline; the run succeeded.
		expect(result.extractedToolData?.yield).toBeDefined();
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.abortReason).toBeUndefined();
	});
});
