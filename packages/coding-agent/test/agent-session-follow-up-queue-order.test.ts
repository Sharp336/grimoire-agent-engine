import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Regression: an autonomous continuation (AutonomousController.#queueContinuation →
 * sendCustomMessage with `{ deliverAs: "followUp", triggerTurn: true }`) can fire
 * from inside #endInFlight's #flushPendingAgentEnd, which runs BEFORE
 * #drainStrandedQueuedMessages. If a user follow-up stranded after the loop's
 * final queue poll is sitting in the follow-up queue, the continuation started
 * a turn immediately (the not-streaming + triggerTurn branch of sendCustomMessage)
 * and reordered itself ahead of the user's input.
 *
 * Contract: when sendCustomMessage is asked to deliver as a "followUp" with a
 * turn trigger but the session already has queued messages, it queues behind
 * them (agent.followUp + idle drain) instead of starting a turn, so the
 * stranded-queue drain runs the user's input first. The drain's continue()
 * dequeues follow-ups in insertion order, preserving the user → autonomous order.
 */
describe("AgentSession follow-up queue order", () => {
	let session: AgentSession;
	let authStorage: AuthStorage;

	function assistantTail(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
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

	async function createSession(
		responses: MockResponse[],
		messages: Parameters<typeof Agent.prototype.appendMessage>[0][] = [],
	): Promise<MockModel> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		return mock;
	}

	beforeEach(async () => {
		// In-memory SQLite avoids Windows EBUSY file-lock contention on cleanup.
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		vi.restoreAllMocks();
	});

	it("queues a triggerTurn follow-up behind an existing queued user message", async () => {
		await createSession([], [{ role: "user", content: "initial objective", timestamp: Date.now() }, assistantTail()]);

		// Simulate a stranded user follow-up: a message that landed in the
		// follow-up queue after the loop's final queue poll, with no drain
		// scheduled yet (the session is idle between #flushPendingAgentEnd and
		// #drainStrandedQueuedMessages). Queue at the agent level directly so
		// no idle drain is kicked.
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "user follow-up" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(session.isStreaming).toBe(false);

		// Block agent.prompt (the turn-start path) so sendCustomMessage's
		// triggerTurn branch cannot start a real turn. Clear queues in the spy
		// so the idle drain (continue → hasQueuedMessages) settles instead of
		// rescheduling forever against a no-op.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const started = await session.sendCustomMessage(
			{
				customType: "autonomous-continuation",
				content: "continue the next steps",
				display: false,
				attribution: "user",
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		// Must NOT start a turn immediately — the user follow-up is still queued
		// ahead of it. The idle drain (continue) is scheduled to run the queue in
		// order once #endInFlight settles, not to jump the autonomous message ahead.
		expect(started).toBe(false);
		// agent.prompt (turn start) was never called — the message was queued.
		expect(promptSpy).not.toHaveBeenCalled();
		// Let the idle drain settle before afterEach disposes the session.
		await session.waitForIdle();
	});

	it("starts a turn immediately when no messages are queued (no reordering to avoid)", async () => {
		await createSession(
			[{ content: ["autonomous answer"] }],
			[{ role: "user", content: "initial objective", timestamp: Date.now() }, assistantTail()],
		);

		// Spy on prompt to detect turn start without running a real turn.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const started = await session.sendCustomMessage(
			{
				customType: "autonomous-continuation",
				content: "continue the next steps",
				display: false,
				attribution: "user",
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		// No queued work to respect — the continuation starts its own turn.
		expect(started).toBe(true);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		await session.waitForIdle();
	});
});
