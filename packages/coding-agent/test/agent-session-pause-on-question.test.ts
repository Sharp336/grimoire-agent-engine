import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

class MockAssistantStream extends AssistantMessageEventStream {}

/**
 * End-to-end coverage of the pause-on-question behavior.
 *
 * Repro for the bug fixed by `assistantMessageEndsWithQuestion`:
 *   1. The assistant ends a turn with a question (e.g. "JWT or session cookies?")
 *      and no tool calls.
 *   2. There is at least one incomplete todo on the list.
 *   3. Pre-fix, `#checkTodoCompletion` would inject a developer reminder and
 *      schedule `#scheduleAgentContinue`, causing the agent to answer its own
 *      question instead of yielding for user input.
 *
 * Post-fix: when `ask.pauseOnQuestion` is enabled (default), the reminder is
 * suppressed, no second LLM call happens, and no `todo_reminder` event fires.
 *
 * We exercise the real `AgentSession` end-to-end (no mocks of the
 * decision logic): a real `Agent`, real `AgentSession`, real settings
 * lookups, real event subscription. The model is stubbed via `streamFn`.
 */
describe("AgentSession pause-on-question (e2e)", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let streamCallCount = 0;
	let scriptedResponses: AssistantMessage[] = [];
	let receivedEvents: AgentSessionEvent[] = [];

	function setup(settingsOverrides: Record<string, unknown>): void {
		streamCallCount = 0;
		scriptedResponses = [];
		receivedEvents = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const modelRegistry = new ModelRegistry(authStorage!, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.eager": false,
			"todo.reminders": true,
			...settingsOverrides,
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				streamCallCount += 1;
				const response = scriptedResponses.shift() ?? createAssistantMessage("done");
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			receivedEvents.push(event);
		});

		// Pre-populate an incomplete todo so #checkTodoCompletion has work to do.
		session.setTodoPhases([
			{
				name: "Implementation",
				tasks: [{ content: "Choose auth strategy", status: "pending" }],
			},
		]);
	}

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-pause-on-question-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("suppresses the todo reminder when the assistant ends with a question", async () => {
		setup({ "ask.pauseOnQuestion": true });

		// One scripted reply: a plain text turn that ends in '?', no tool calls.
		// `stopReason: "stop"` ensures the session reaches the
		// post-stop hook in `#handleAgentEvent` where `#checkTodoCompletion` runs.
		scriptedResponses = [createAssistantMessage("Should we use JWT or session cookies?")];

		await session.prompt("set up auth");
		await session.waitForIdle();

		// Assistant turn ran exactly once. No follow-up was scheduled.
		expect(streamCallCount).toBe(1);

		// No `todo_reminder` event fired.
		const reminders = receivedEvents.filter(event => event.type === "todo_reminder");
		expect(reminders).toEqual([]);

		// No developer reminder injected. Pre-fix behavior would have appended
		// a developer message containing "<system-reminder>" with the incomplete
		// todo list before scheduling another agent.continue() call.
		const developerReminders = session.agent.state.messages.filter(
			message =>
				message.role === "developer" &&
				Array.isArray(message.content) &&
				message.content.some(part => part.type === "text" && part.text.includes("<system-reminder>")),
		);
		expect(developerReminders).toEqual([]);

		// The conversation is exactly: prompt → assistant question. Nothing else.
		const roles = session.agent.state.messages.map(message => message.role);
		expect(roles).toEqual(["user", "assistant"]);
	});

	it("does NOT suppress the todo reminder when the assistant ends with a statement", async () => {
		setup({ "ask.pauseOnQuestion": true, "todo.reminders.max": 1 });

		// First reply is a plain declarative turn — no question, no tool call.
		// Second reply is the agent's response to the injected reminder.
		scriptedResponses = [
			createAssistantMessage("Authentication wired up."),
			createAssistantMessage("All todos complete."),
		];

		await session.prompt("set up auth");
		await session.waitForIdle();

		// The reminder DID fire and the agent was continued.
		expect(streamCallCount).toBe(2);

		const reminders = receivedEvents.filter(event => event.type === "todo_reminder");
		expect(reminders).toHaveLength(1);

		const developerReminders = session.agent.state.messages.filter(
			message =>
				message.role === "developer" &&
				Array.isArray(message.content) &&
				message.content.some(part => part.type === "text" && part.text.includes("<system-reminder>")),
		);
		expect(developerReminders).toHaveLength(1);
	});

	it("does NOT suppress the reminder when ask.pauseOnQuestion is disabled (escape hatch)", async () => {
		setup({ "ask.pauseOnQuestion": false, "todo.reminders.max": 1 });

		scriptedResponses = [
			createAssistantMessage("Should we use JWT or session cookies?"),
			createAssistantMessage("All todos complete."),
		];

		await session.prompt("set up auth");
		await session.waitForIdle();

		// With the safety net disabled, the bug behavior returns: the reminder
		// fires and the agent answers its own question.
		expect(streamCallCount).toBe(2);

		const reminders = receivedEvents.filter(event => event.type === "todo_reminder");
		expect(reminders).toHaveLength(1);
	});
});
