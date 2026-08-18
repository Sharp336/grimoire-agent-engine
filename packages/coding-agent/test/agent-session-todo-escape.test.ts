import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

function textOnlyAssistant(text = "Task complete. All 1 items now wired."): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
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
}

describe("AgentSession todo-escape tool_choice", () => {
	let tempDir: TempDir;
	let session: AgentSession;

	function emitTextOnlyStop(text?: string): void {
		const msg = textOnlyAssistant(text);
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	let servedToolChoice: unknown;

	async function createSession(model: Model): Promise<void> {
		tempDir = TempDir.createSync("@pi-todo-escape-session-");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const todoTool: AgentTool = {
			name: "todo",
			label: "Todo",
			description: "Todo",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		servedToolChoice = undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todoTool],
				messages: [],
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, _context, options) => {
				servedToolChoice = options?.toolChoice;
				const response = textOnlyAssistant("Which trade-off should I optimize for?");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders": true,
				"todo.remindersMax": 1,
				"todo.eager": "default",
			}),
			modelRegistry: sharedModelRegistry,
			toolRegistry: new Map([[todoTool.name, todoTool]]),
		});
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "do the thing", status: "pending" }] }]);
	}

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("queues todo-escape and drops it when a user prompt preempts the continue", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		await createSession(model);
		vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop();
		await session.waitForIdle();
		expect(session.toolChoiceQueue.inspect()).toContain("todo-escape");

		await session.prompt("new user instruction");
		await session.waitForIdle();
		// The leftover hatch must not be served on the user turn. The turn yields
		// with a real question so it does not immediately re-queue a new hatch.
		expect(servedToolChoice).toBeUndefined();
		expect(session.toolChoiceQueue.inspect()).not.toContain("todo-escape");
	});

	it("pins the named todo tool on Google instead of a generic required choice", async () => {
		const base = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!base) throw new Error("Expected bundled anthropic model");
		const google = { ...base, api: "google-generative-ai", provider: "google", id: "gemini-2.5-flash" } as Model;
		await createSession(google);
		vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop();
		await session.waitForIdle();
		expect(session.toolChoiceQueue.inspect()).toContain("todo-escape");
		expect(session.toolChoiceQueue.nextToolChoice()).toEqual({ type: "tool", name: "todo" });
	});
});
