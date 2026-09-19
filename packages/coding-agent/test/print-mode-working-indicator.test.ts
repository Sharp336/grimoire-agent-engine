import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PlanProposalHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";

function makeAssistantMessage(text: string): AssistantMessage {
	const timestamp = Date.now();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp,
	};
}

interface DelayedSession {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
	getPlanModeAtPrompt: () => PlanModeState | undefined;
	getTextOutputCommitted: () => boolean;
	getModeChanges: () => Array<{ mode: string; data?: Record<string, unknown> }>;
	getPlanProposalHandler: () => PlanProposalHandler | undefined;
	getCurrentPlanMode: () => PlanModeState | undefined;
	emit: (event: AgentSessionEvent) => void;
	getAbortCalls: () => number;
}

function createDelayedSession(
	finalMessage: AssistantMessage,
	options: { defaultPlanMode?: boolean } = {},
): DelayedSession {
	const messages: AssistantMessage[] = [];
	const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
	const { promise: promptReleased, resolve: resolvePrompt } = Promise.withResolvers<void>();
	let planModeState: PlanModeState | undefined;
	let planModeAtPrompt: PlanModeState | undefined;
	let enabledToolNames = ["read"];
	const modeChanges: Array<{ mode: string; data?: Record<string, unknown> }> = [];
	let planProposalHandler: PlanProposalHandler | undefined;
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	let textOutputCommitted = true;
	let abortCalls = 0;

	const session = {
		state: { messages },
		getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
		sessionManager: {
			getHeader: () => undefined,
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			appendModeChange: (mode: string, data?: Record<string, unknown>) => {
				modeChanges.push({ mode, data });
				return "mode-change";
			},
		},
		settings: {
			get: (key: string) =>
				key === "plan.enabled" || (key === "plan.defaultOnStartup" && options.defaultPlanMode === true),
		},
		model: undefined,
		isStreaming: false,
		getPlanReferencePath: () => "",
		getEnabledToolNames: () => enabledToolNames,
		hasBuiltInTool: (name: string) => name === "write",
		setActiveToolsByName: async (names: string[]) => {
			enabledToolNames = names;
		},
		getPlanModeState: () => planModeState,
		setPlanModeState: (state: PlanModeState | undefined) => {
			planModeState = state;
		},
		preparePlanForReview: async (title: string) => {
			const details = { planFilePath: `local://${title}-plan.md`, title, planExists: true };
			return { content: [{ type: "text" as const, text: "Plan ready for review." }], details };
		},
		setPlanProposalHandler: (handler: PlanProposalHandler | null) => {
			planProposalHandler = handler ?? undefined;
		},
		resolveRoleModelWithThinking: () => ({
			model: undefined,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
		}),
		extensionRunner: undefined,
		markPlanInternalAbortPending: () => {},
		clearPlanInternalAbortPending: () => {},
		abort: async () => {
			abortCalls++;
		},
		setTextOutputCommitted: (committed: boolean) => {
			textOutputCommitted = committed;
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		prompt: async () => {
			planModeAtPrompt = planModeState;
			markPromptStarted();
			await promptReleased;
			messages.push(finalMessage);
			return true;
		},
		dispose: async () => {},
	} as unknown as AgentSession;

	return {
		session,
		promptStarted,
		resolvePrompt,
		getPlanModeAtPrompt: () => planModeAtPrompt,
		getModeChanges: () => modeChanges,
		getPlanProposalHandler: () => planProposalHandler,
		getTextOutputCommitted: () => textOutputCommitted,
		getCurrentPlanMode: () => planModeState,
		emit: event => subscriber?.(event),
		getAbortCalls: () => abortCalls,
	};
}

describe("print mode working indicator", () => {
	let stderrOutput: string[];
	let stdoutOutput: string[];
	let stdoutEvents: Array<"write" | "flush">;

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		stdoutEvents = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") {
				stdoutOutput.push(chunk);
				if (chunk.length > 0) stdoutEvents.push("write");
			}
			const last = args[args.length - 1];
			if (typeof last === "function") {
				stdoutEvents.push("flush");
				last();
			}
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not enter startup plan mode in headless print mode and warns instead (#8272)", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"), { defaultPlanMode: true });
		const run = runPrintMode(delayed.session, { mode: "text", initialMessage: "Reply with exactly: OK" });

		await delayed.promptStarted;
		try {
			// Headless has no surface to review/approve/exit a plan, so the startup
			// default must not arm the plan-review flow — doing so stranded the turn
			// until the deadline (issue #8272).
			expect(delayed.getPlanModeAtPrompt()).toBeUndefined();
			expect(delayed.getModeChanges()).toEqual([]);
			expect(delayed.getPlanProposalHandler()).toBeUndefined();
			expect(stderrOutput.join("")).toContain("plan.defaultOnStartup is ignored in print mode");
		} finally {
			delayed.resolvePrompt();
			await run;
		}

		expect(stdoutOutput.join("")).toBe("final answer\n");
	});

	it("suppresses the startup-default note when the headless plan flow is already active", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"), { defaultPlanMode: true });
		const run = runPrintMode(delayed.session, {
			mode: "text",
			initialMessage: "Reply with exactly: OK",
			planYolo: true,
		});

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).not.toContain("plan.defaultOnStartup");
		} finally {
			delayed.resolvePrompt();
			await run;
		}
	});

	it("writes a text-mode working indicator before the prompt resolves and prints the final answer afterward", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, { mode: "text", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toContain("Working");
			expect(stdoutOutput.join("")).toBe("");
			expect(delayed.getTextOutputCommitted()).toBe(false);
		} finally {
			delayed.resolvePrompt();
			await run;
		}

		expect(stdoutOutput.join("")).toBe("final answer\n");
		expect(delayed.getTextOutputCommitted()).toBe(true);
	});

	it("does not write the text-mode working indicator in JSON mode while the prompt is pending", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("json answer"));
		const run = runPrintMode(delayed.session, { mode: "json", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toBe("");
			expect(delayed.getTextOutputCommitted()).toBe(true);
		} finally {
			delayed.resolvePrompt();
			await run;
		}
	});

	it("writes the text-mode working indicator once across successive prompts", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, {
			mode: "text",
			initialMessage: "hello",
			messages: ["follow-up"],
		});

		await delayed.promptStarted;
		delayed.resolvePrompt();
		await run;

		expect(stderrOutput.join("")).toBe("Working...\n");
	});
});
