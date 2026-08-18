import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { TempDir } from "@oh-my-pi/pi-utils";

function textOnlyAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("TodoTracker escape-hatch continue skip", () => {
	it("passes onSkip so a skipped continue can drop the forced todo", async () => {
		const tempDir = TempDir.createSync("@pi-todo-escape-");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		const scheduled: Array<{ generation?: number; onSkip?: () => void }> = [];
		let cleared = 0;
		const host: TodoTrackerHost = {
			agent,
			sessionManager,
			settings: Settings.isolated({
				"todo.enabled": true,
				"todo.reminders": true,
				"todo.remindersMax": 1,
			}),
			model: () => model,
			agentKind: () => "main",
			emitSessionEvent: async () => {},
			scheduleAgentContinue: options => {
				scheduled.push(options);
			},
			clearForcedTodoToolChoice: () => {
				cleared += 1;
			},
			promptGeneration: () => 3,
			hasPendingAsyncWake: () => false,
			getActiveToolNames: () => ["todo"],
			toolRegistry: () => new Map(),
			planModeEnabled: () => false,
			consumeLastServedToolChoiceLabel: () => undefined,
			forceTodoToolChoice: () => true,
		};

		const tracker = new TodoTracker(host);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "do the thing", status: "pending" }] }]);

		const reminded = await tracker.checkCompletion(textOnlyAssistant("Task complete. All 1 items now wired."));
		expect(reminded).toBe(true);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.generation).toBe(3);
		expect(scheduled[0]?.onSkip).toBeTypeOf("function");

		scheduled[0]?.onSkip?.();
		expect(cleared).toBe(1);

		await tempDir.remove();
	});
});
