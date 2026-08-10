import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { resolveSoftRequestBudget, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contracts under test — the soft request budget must degrade gracefully
 * instead of killing scouts into an unreachable state:
 *
 * 1. Crossing 1.5x the budget stops the free-running turn and drives ONE
 *    forced final `yield`, so the run finishes as a normal completion with a
 *    partial report — not as an abort with no output.
 * 2. If the agent still refuses to yield (grace exhausted → hard abort), a
 *    kept-alive agent stays adopted (`idle`), so `irc` can message/resume it
 *    with the same RPC lifecycle/progress frames as the original run.
 * 3. Caller-signal aborts remain terminal, and the irc bus names the aborted
 *    agent precisely instead of claiming it is unknown.
 */

interface MockSessionHandle {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	abortCalls: () => number;
	disposeCalls: () => number;
}

interface MockSessionOptions {
	settings?: Settings;
	onIrcWake?: (params: { emit: (event: AgentSessionEvent) => void; pushMessage: (message: unknown) => void }) => void;
}

function assistantText(text: string, stopReason: "stop" | "aborted" = "stop") {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason };
}

function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
	}) => void,
	options: MockSessionOptions = {},
): MockSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	let abortCount = 0;
	let disposeCount = 0;
	let promptIndex = 0;
	let ircWakeTurnObserver:
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		settings: options.settings ?? Settings.isolated(),
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
			onPrompt({ promptIndex, emit, pushMessage: message => messages.push(message) });
			return true;
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async () => {},
		setIrcWakeTurnObserver: observer => {
			ircWakeTurnObserver = observer;
		},
		deliverIrcMessage: async msg => {
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:incoming",
				content: msg.body,
				display: true,
				details: { id: msg.id, from: msg.from, message: msg.body },
				attribution: "agent",
				timestamp: msg.ts,
			};
			const finishObservation = ircWakeTurnObserver?.([record]);
			options.onIrcWake?.({ emit, pushMessage: message => messages.push(message) });
			const yieldMessage = {
				role: "assistant" as const,
				content: [
					{
						type: "toolCall" as const,
						id: "tool-irc-yield",
						name: "yield",
						arguments: { result: { data: { report: "resumed findings" } } },
					},
				],
				stopReason: "toolUse" as const,
			};
			messages.push(yieldMessage);
			emit({ type: "agent_start" } as AgentSessionEvent);
			emit({ type: "message_end", message: yieldMessage } as unknown as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-irc-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "resumed findings" } },
				},
				isError: false,
			} as AgentSessionEvent);
			emit({ type: "agent_end", messages: [yieldMessage] } as unknown as AgentSessionEvent);
			await finishObservation?.();
			return "woken";
		},
		abort: async () => {
			abortCount += 1;
		},
		dispose: async () => {
			disposeCount += 1;
		},
	};

	return {
		session: session as AgentSession,
		prompts,
		abortCalls: () => abortCount,
		disposeCalls: () => disposeCount,
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
// Use a bundled scout so these runSubprocess tests exercise the built-in
// ceiling together with a lower task.softRequestBudget setting.
const baseAgent: AgentDefinition = {
	name: "scout",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess soft request budget", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-soft-budget-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string, eventBus?: EventBus) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({ "task.softRequestBudget": 2 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
			eventBus,
		};
	}

	function registerRunning(id: string, session: AgentSession) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: null,
			status: "running",
		});
	}

	function emitToolExecution(
		emit: (event: AgentSessionEvent) => void,
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
		result: unknown,
		isError = false,
	): void {
		emit({ type: "tool_execution_start", toolCallId, toolName, args });
		emit({ type: "tool_execution_end", toolCallId, toolName, result, isError });
	}

	function emitSuccessfulYield(
		emit: (event: AgentSessionEvent) => void,
		pushMessage: (message: unknown) => void,
	): void {
		const toolCallId = "terminal-yield";
		const args = { result: { data: { report: "completed" } } };
		pushMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "yield", arguments: args }],
			stopReason: "toolUse",
		});
		emit({ type: "tool_execution_start", toolCallId, toolName: "yield", args });
		emit({
			type: "tool_execution_end",
			toolCallId,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { report: "completed" } },
			},
			isError: false,
		});
	}

	function convergenceOptions(
		id: string,
		loopGuard: {
			enabled?: boolean;
			threshold?: number;
			exemptTools?: string[];
		} = {},
	) {
		return {
			...baseOptions(id),
			settings: Settings.isolated({
				"task.softRequestBudget": 0,
				"model.toolCallLoopGuard.enabled": loopGuard.enabled ?? true,
				"model.toolCallLoopGuard.threshold": loopGuard.threshold ?? 3,
				"model.toolCallLoopGuard.exemptTools": loopGuard.exemptTools ?? ["hub"],
			}),
		};
	}

	it("a budget stop drives one forced final yield and finishes as a normal completion", async () => {
		const id = "BudgetScout";
		let abortCallsAtReminder: number | undefined;
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex === 1) {
				// Free-running exploration: budget 2 → stop threshold 3.
				for (let i = 1; i <= 3; i++) {
					const message = assistantText(`exploring ${i}`, i === 3 ? "aborted" : "stop");
					pushMessage(message);
					emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				}
				return;
			}
			// The forced wrap-up reminder: answer it with a terminal yield.
			abortCallsAtReminder = handle.abortCalls();
			const yieldMessage = {
				role: "assistant" as const,
				content: [
					{
						type: "toolCall" as const,
						id: "tool-forced-yield",
						name: "yield",
						arguments: { result: { data: { report: "partial findings" } } },
					},
				],
				stopReason: "toolUse" as const,
			};
			pushMessage(yieldMessage);
			emit({ type: "message_end", message: yieldMessage } as unknown as AgentSessionEvent);
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
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id));

		// The budget stop aborted the free-running turn exactly once before the
		// wrap-up reminder; the second abort (after the terminal yield) is the
		// normal post-yield terminate.
		expect(abortCallsAtReminder).toBe(1);
		// The wrap-up reminder is the budget-stop variant with a forced tool choice.
		expect(handle.prompts).toHaveLength(2);
		expect(handle.prompts[1]?.text).toMatch(/request budget/);
		expect(handle.prompts[1]?.options?.synthetic).toBe(true);
		expect(handle.prompts[1]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
		// The forced yield finalizes as a normal completion, not an abort.
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ report: "partial findings" });
		// The agent stays a live, adopted peer.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);
	});

	it("a budget hard-abort keeps the kept-alive agent adopted and messageable via irc", async () => {
		const id = "StubbornScout";
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		let resolveFollowUpTerminal: (() => void) | undefined;
		const waitForFollowUpTerminal = (): Promise<void> => {
			const deferred = Promise.withResolvers<void>();
			resolveFollowUpTerminal = deferred.resolve;
			return deferred.promise;
		};
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type !== "subagent_lifecycle" || frame.payload.status === "started") return;
			const resolve = resolveFollowUpTerminal;
			resolveFollowUpTerminal = undefined;
			resolve?.();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			// Never yields: budget 2 → stop at 3, grace exhausted at 3 + 5 = 8.
			for (let i = 1; i <= 8; i++) {
				const message = assistantText(`burning request ${i}`);
				pushMessage(message);
				emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			}
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id, eventBus));

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toMatch(/Soft request budget exceeded/);
		// Resumable stop, not a terminal kill: the ref stays adopted and live.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);

		const expectRpcTurn = (): void => {
			expect(frames[0]).toMatchObject({
				type: "subagent_lifecycle",
				payload: { id, status: "started" },
			});
			expect(frames.some(frame => frame.type === "subagent_progress")).toBe(true);
			expect(frames.at(-1)).toMatchObject({
				type: "subagent_lifecycle",
				payload: { id, status: "completed" },
			});
		};

		frames.length = 0;
		const idleTerminal = waitForFollowUpTerminal();
		const idleReceipt = await new IrcBus().send({ from: "Main", to: id, body: "resume your inventory" });
		expect(idleReceipt.outcome).toBe("woken");
		await idleTerminal;
		expectRpcTurn();

		await AgentLifecycleManager.global().park(id);
		expect(AgentRegistry.global().get(id)?.status).toBe("parked");
		frames.length = 0;
		const revivedTerminal = waitForFollowUpTerminal();
		const revivedReceipt = await new IrcBus().send({ from: "Main", to: id, body: "resume after parking" });
		expect(revivedReceipt.outcome).toBe("revived");
		await revivedTerminal;
		expectRpcTurn();
		rpcRegistry.dispose();
	});

	it("a caller-signal abort stays terminal and irc names the aborted agent precisely", async () => {
		const id = "CancelledScout";
		const controller = new AbortController();
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			const message = assistantText("working");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			controller.abort();
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess({ ...baseOptions(id), signal: controller.signal });

		expect(result.aborted).toBe(true);
		expect(AgentRegistry.global().get(id)?.status).toBe("aborted");
		expect(handle.disposeCalls()).toBeGreaterThanOrEqual(1);

		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "resume" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(receipt.error).toMatch(new RegExp(`history://${id}`));
	});

	it("uses the configured threshold and canonical JSON arguments and results", async () => {
		const id = "LoopScout";
		const handle = createMockSession(({ emit }) => {
			emitToolExecution(
				emit,
				"tool-1",
				"read",
				{ path: "/tmp/same.ts", options: { offset: 1, limit: 20 } },
				{ content: [{ type: "text", text: "same result" }], details: { bytes: 20, complete: true } },
			);
			emitToolExecution(
				emit,
				"tool-2",
				"read",
				{ options: { limit: 20, offset: 1 }, path: "/tmp/same.ts" },
				{ details: { complete: true, bytes: 20 }, content: [{ text: "same result", type: "text" }] },
			);
			emitToolExecution(
				emit,
				"tool-3",
				"read",
				{ path: "/tmp/same.ts", options: { offset: 1, limit: 20 } },
				{ content: [{ type: "text", text: "same result" }], details: { bytes: 20, complete: true } },
			);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(convergenceOptions(id, { threshold: 3 }));

		expect(result.exitCode).not.toBe(0);
		expect(result.error).toContain("identical arguments and results 3 times");
		expect(result.error).toContain("non-converging");
	});

	it("uses live session settings and reports autonomous IRC convergence failures", async () => {
		const id = "IrcLoopScout";
		const settings = Settings.isolated({
			"task.softRequestBudget": 0,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["hub"],
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		let resolveWakeTerminal: (() => void) | undefined;
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") {
				resolveWakeTerminal?.();
			}
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const handle = createMockSession(({ emit, pushMessage }) => emitSuccessfulYield(emit, pushMessage), {
			settings,
			onIrcWake: ({ emit }) => {
				const args = { path: "/tmp/same.ts" };
				const result = { content: [{ type: "text", text: "same result" }] };
				emitToolExecution(emit, "irc-read-1", "read", args, result);
				emitToolExecution(emit, "irc-read-2", "read", args, result);
			},
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);
		const initial = await runSubprocess({ ...baseOptions(id, eventBus), settings });
		const abortsBeforeWake = handle.abortCalls();
		frames.length = 0;
		const terminal = Promise.withResolvers<void>();
		resolveWakeTerminal = terminal.resolve;

		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "continue" });
		await terminal.promise;

		expect(initial.exitCode).toBe(0);
		expect(receipt.outcome).toBe("woken");
		expect(handle.abortCalls()).toBe(abortsBeforeWake + 1);
		expect(frames.at(-1)).toMatchObject({
			type: "subagent_lifecycle",
			payload: { id, status: "failed" },
		});
		rpcRegistry.dispose();
	});

	it("does not enforce convergence detection when the centralized guard is disabled", async () => {
		const id = "DisabledLoopGuardScout";
		const handle = createMockSession(({ emit, pushMessage }) => {
			for (let index = 1; index <= 3; index++) {
				emitToolExecution(
					emit,
					`tool-${index}`,
					"read",
					{ path: "/tmp/same.ts" },
					{ content: [{ type: "text", text: "same result" }] },
				);
			}
			emitSuccessfulYield(emit, pushMessage);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(convergenceOptions(id, { enabled: false, threshold: 2 }));

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "completed" });
	});

	it("preserves configured exemptions for repeated polling tools", async () => {
		const id = "PollingScout";
		const handle = createMockSession(({ emit, pushMessage }) => {
			for (let index = 1; index <= 3; index++) {
				emitToolExecution(
					emit,
					`wait-${index}`,
					"hub",
					{ op: "wait" },
					{ content: [{ type: "text", text: "no completed jobs yet" }] },
				);
			}
			emitSuccessfulYield(emit, pushMessage);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(convergenceOptions(id, { threshold: 2, exemptTools: ["hub"] }));

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "completed" });
	});

	it("treats result changes under nested intent-named keys as progress", async () => {
		const id = "ProgressingScout";
		const handle = createMockSession(({ emit, pushMessage }) => {
			for (let index = 1; index <= 3; index++) {
				emitToolExecution(
					emit,
					`read-${index}`,
					"read",
					{ path: "/tmp/growing.log" },
					{
						content: [{ type: "text", text: "same result" }],
						details: { progress: { i: `result ${index}` } },
					},
				);
			}
			emitSuccessfulYield(emit, pushMessage);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(convergenceOptions(id, { threshold: 2, exemptTools: [] }));

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "completed" });
	});

	it("resets the consecutive-success streak after a failed call", async () => {
		const id = "RecoveringScout";
		const handle = createMockSession(({ emit, pushMessage }) => {
			const args = { path: "/tmp/same.ts" };
			const success = { content: [{ type: "text", text: "same result" }] };
			emitToolExecution(emit, "success-1", "read", args, success);
			emitToolExecution(emit, "success-2", "read", args, success);
			emitToolExecution(
				emit,
				"failure",
				"read",
				args,
				{ content: [{ type: "text", text: "temporary failure" }] },
				true,
			);
			emitToolExecution(emit, "success-3", "read", args, success);
			emitToolExecution(emit, "success-4", "read", args, success);
			emitSuccessfulYield(emit, pushMessage);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(convergenceOptions(id, { threshold: 3, exemptTools: [] }));

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "completed" });
	});
});

describe("resolveSoftRequestBudget", () => {
	it("lets a configured budget lower a bundled agent's ceiling", () => {
		expect(resolveSoftRequestBudget("scout", 20)).toBe(20);
		expect(resolveSoftRequestBudget("sonic", 20)).toBe(20);
	});

	it("keeps the bundled ceiling when the configured budget is higher", () => {
		expect(resolveSoftRequestBudget("scout", 200)).toBe(100);
		expect(resolveSoftRequestBudget("sonic", 200)).toBe(100);
	});

	it("uses the configured budget for agents without a bundled entry", () => {
		expect(resolveSoftRequestBudget("task", 20)).toBe(20);
	});

	it("keeps 0 disabled and normalizes negative or fractional budgets", () => {
		expect(resolveSoftRequestBudget("scout", 0)).toBe(0);
		expect(resolveSoftRequestBudget("scout", -5)).toBe(0);
		expect(resolveSoftRequestBudget("scout", 20.9)).toBe(20);
	});
});
