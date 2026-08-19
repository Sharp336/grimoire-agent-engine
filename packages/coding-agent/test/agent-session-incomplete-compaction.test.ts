/**
 * Tests for the `response.incomplete` / `stopReason === "length"` recovery path
 * in `SessionMaintenance.checkCompaction`.
 *
 * When a model burns its output-token budget (reasoning-only or truncated
 * output), the recovery path previously ran compaction unconditionally — even
 * when context was well below the compaction threshold. This test verifies the
 * fix:
 *   - compaction only fires when context is above the threshold
 *   - below it, the dead turn is dropped from the branch and a continuation
 *     is scheduled (verify via observable session state)
 *   - repeated length stops fall back to compaction after the retry bound
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A length-stop message as produced by OpenAI Responses/Codex for response.incomplete. */
function createIncompleteMessage(model: Model, contextTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: contextTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: contextTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "length",
		timestamp: Date.now(),
	};
}

/** Same pattern as agent-session-context-promotion.test.ts: queueMicrotask drains
 *  the fire-and-forget agent_end handler; waitForIdle settles tracked continuation
 *  work (the 100ms delayed scheduleAgentContinue lands on a real timer, so awaiting
 *  one event-loop turn is enough). */
async function settle(session: AgentSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	queueMicrotask(() => resolve());
	await promise;
	await session.waitForIdle();
}

function branchEntriesOf(session: AgentSession): SessionEntry[] {
	return session.sessionManager.getBranch();
}

function lengthStopMessagesOf(session: AgentSession): SessionEntry[] {
	return branchEntriesOf(session).filter(
		entry =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			(entry.message as AssistantMessage).stopReason === "length",
	);
}

/**
 * Observable compaction trigger. `auto_compaction_start` fires before the
 * actual summarization model call, so it is the true contract signal for
 * "the recovery path decided to compact" — the entry only lands on the branch
 * if the summarization succeeds, which requires a real API key in tests.
 */
function compactionStartEventsOf(events: AgentSessionEvent[]): number {
	return events.filter(event => event.type === "auto_compaction_start").length;
}

describe("response.incomplete recovery — compaction threshold gating", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-incomplete-compaction-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(options: { contextWindow: number; thresholdTokens: number }): {
		session: AgentSession;
		events: AgentSessionEvent[];
	} {
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": options.thresholdTokens,
			"contextPromotion.enabled": false,
		});

		const testModel: Model = { ...bundledModel, contextWindow: options.contextWindow };

		const agent = new Agent({
			initialState: {
				model: testModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		return { session, events };
	}

	it("does NOT compact when context is below the threshold", async () => {
		const { session, events } = createSession({ contextWindow: 100_000, thresholdTokens: 80_000 });

		const incompleteMsg = createIncompleteMessage(bundledModel, 10_000);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMsg] });

		await settle(session);

		// The fix: no compaction was triggered for a below-threshold length stop.
		expect(compactionStartEventsOf(events)).toBe(0);
		// The dead turn is dropped from the persisted branch.
		expect(lengthStopMessagesOf(session).length).toBe(0);
		await session.dispose();
	});

	it("DOES compact when context exceeds the threshold", async () => {
		const { session, events } = createSession({ contextWindow: 100_000, thresholdTokens: 80_000 });

		const incompleteMsg = createIncompleteMessage(bundledModel, 90_000);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMsg] });

		await settle(session);

		// Above threshold: the recovery path triggers compaction. The summarization
		// itself fails without a real API key, but the trigger decision is the contract.
		expect(compactionStartEventsOf(events)).toBeGreaterThan(0);
		await session.dispose();
	});

	it("falls back to compaction after 3 consecutive below-threshold length stops", async () => {
		const { session, events } = createSession({ contextWindow: 100_000, thresholdTokens: 80_000 });

		for (let i = 0; i < 3; i++) {
			const incompleteMsg = createIncompleteMessage(bundledModel, 10_000);
			session.agent.emitExternalEvent({ type: "message_end", message: incompleteMsg });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMsg] });
			await settle(session);
		}

		// First 3: retried without compaction.
		expect(compactionStartEventsOf(events)).toBe(0);

		// 4th stop: exceeds the retry bound, compaction fires.
		const incompleteMsg = createIncompleteMessage(bundledModel, 10_000);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMsg] });
		await settle(session);

		expect(compactionStartEventsOf(events)).toBe(1);
		await session.dispose();
	});

	it("does NOT compact when output tokens inflate totalTokens but prompt tokens are below threshold", async () => {
		// 10k input reads as 85k with calculateContextTokens and would compact
		// even though the retry replays ~10k. calculatePromptTokens excludes
		// the discarded output tokens.
		const { session, events } = createSession({ contextWindow: 100_000, thresholdTokens: 80_000 });

		const incompleteMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			api: bundledModel.api,
			provider: bundledModel.provider,
			model: bundledModel.id,
			usage: {
				input: 10_000,
				output: 75_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 85_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMsg] });

		await settle(session);

		// 85k totalTokens but only 10k prompt tokens — below 80k threshold.
		expect(compactionStartEventsOf(events)).toBe(0);
		await session.dispose();
	});
});
