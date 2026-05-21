import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function createAssistantMessage(model: Model, input: number, output: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: output > 0 ? "assistant response" : "continuation" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession context usage", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("uses Cursor cumulative totalTokens in session stats without summing each turn as input", () => {
		const cursorModel: Model<"cursor-agent"> = {
			id: "gpt-5.5-extra-high",
			name: "GPT-5.5 Extra High",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 64_000,
		};
		const turn1 = createAssistantMessage(cursorModel, 0, 100);
		turn1.usage.totalTokens = 10_000;
		const turn2 = createAssistantMessage(cursorModel, 0, 200);
		turn2.usage.totalTokens = 25_000;
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(turn1);
		sessionManager.appendMessage(turn2);
		const agent = new Agent({
			initialState: {
				model: cursorModel,
				systemPrompt: [],
				tools: [],
				messages: [turn1, turn2],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const stats = session.getSessionStats();

		expect(stats.tokens.output).toBe(300);
		expect(stats.tokens.total).toBe(25_000);
		expect(stats.tokens.input).toBe(24_700);
	});

	it("uses Cursor cumulative totalTokens in SessionManager usage statistics", () => {
		const cursorModel: Model<"cursor-agent"> = {
			id: "gpt-5.5-extra-high",
			name: "GPT-5.5 Extra High",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 64_000,
		};
		const turn1 = createAssistantMessage(cursorModel, 0, 100);
		turn1.usage.totalTokens = 10_000;
		const turn2 = createAssistantMessage(cursorModel, 0, 200);
		turn2.usage.totalTokens = 25_000;
		const sessionManager = SessionManager.inMemory();

		sessionManager.appendMessage(turn1);
		sessionManager.appendMessage(turn2);

		const stats = sessionManager.getUsageStatistics();
		expect(stats.output).toBe(300);
		expect(stats.input).toBe(24_700);
	});

	it("scopes getSessionStats() to the active branch, ignoring abandoned-branch usage in SessionManager", () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		const activeTurn = createAssistantMessage(bundled, 100, 200);
		const abandonedTurn = createAssistantMessage(bundled, 999, 888);

		const sessionManager = SessionManager.inMemory();
		// Both turns hit the session-wide accumulator
		sessionManager.appendMessage(abandonedTurn);
		sessionManager.appendMessage(activeTurn);

		// Only activeTurn lives on the active branch
		const agent = new Agent({
			initialState: {
				model: bundled,
				systemPrompt: [],
				tools: [],
				messages: [activeTurn],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const stats = session.getSessionStats();

		expect(stats.tokens.input).toBe(100);
		expect(stats.tokens.output).toBe(200);
		expect(stats.assistantMessages).toBe(1);
		// The session-wide accumulator still carries the abandoned turn.
		const sessionWide = sessionManager.getUsageStatistics();
		expect(sessionWide.input).toBe(100 + 999);
		expect(sessionWide.output).toBe(200 + 888);
	});

	it("includes live streaming assistant usage before message_end", () => {
		const cursorModel: Model<"cursor-agent"> = {
			id: "gpt-5.5-extra-high",
			name: "GPT-5.5 Extra High",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 64_000,
		};
		const previousTurn = createAssistantMessage(cursorModel, 0, 100);
		previousTurn.usage.totalTokens = 10_000;
		const streamingTurn = createAssistantMessage(cursorModel, 0, 200);
		streamingTurn.usage.totalTokens = 25_000;
		const agent = new Agent({
			initialState: {
				model: cursorModel,
				systemPrompt: [],
				tools: [],
				messages: [previousTurn],
			},
		});
		agent.state.streamMessage = streamingTurn;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const usage = session.getContextUsage();

		expect(usage?.tokens).toBe(25_000);
		expect(usage?.percent).toBeCloseTo((25_000 / 272_000) * 100);
	});

	it("reports streaming usage after compaction before any post-compaction assistant finishes", () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		const model = { ...bundled, contextWindow: 10_000 };
		const preCompactionAssistant = createAssistantMessage(model, 8_000, 200);
		const streamingTurn = createAssistantMessage(model, 1_500, 300);

		const sessionManager = SessionManager.inMemory();
		const msgId = sessionManager.appendMessage(preCompactionAssistant);
		sessionManager.appendCompaction("summary", undefined, msgId, 8_500);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: [],
				tools: [],
				messages: [preCompactionAssistant],
			},
		});
		agent.state.streamMessage = streamingTurn;
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const usage = session.getContextUsage();

		expect(usage?.tokens).not.toBeNull();
		expect(usage?.percent).not.toBeNull();
		expect(usage?.tokens).toBeGreaterThanOrEqual(1_500);
	});

	it("returns null tokens after compaction when no streaming and no post-compaction assistant", () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		const model = { ...bundled, contextWindow: 10_000 };
		const preCompactionAssistant = createAssistantMessage(model, 8_000, 200);

		const sessionManager = SessionManager.inMemory();
		const msgId = sessionManager.appendMessage(preCompactionAssistant);
		sessionManager.appendCompaction("summary", undefined, msgId, 8_500);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: [],
				tools: [],
				messages: [preCompactionAssistant],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const usage = session.getContextUsage();

		expect(usage?.tokens).toBeNull();
		expect(usage?.percent).toBeNull();
	});

	it("ignores zero-usage assistant continuations when anchoring context tokens", () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		const model = { ...bundled, contextWindow: 10_000 };
		const realUsage = createAssistantMessage(model, 1_200, 200);
		const zeroUsageContinuation = createAssistantMessage(model, 0, 0);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: [],
				tools: [],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }, realUsage, zeroUsageContinuation],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const usage = session.getContextUsage();

		expect(usage?.tokens).toBeGreaterThanOrEqual(1_200);
		expect(usage?.percent).toBeGreaterThan(0);
	});
});
