/**
 * Tests for the `response.incomplete` / `stopReason === "length"` recovery path
 * in `SessionMaintenance.checkCompaction`.
 *
 * When a model burns its output-token budget (reasoning-only or truncated
 * output), the recovery path previously ran compaction unconditionally — even
 * when context was well below the compaction threshold. This test verifies the
 * fix: compaction only fires when context is above the threshold; below it,
 * the dead turn is dropped and the agent retries directly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function createIncompleteMessage(
	model: Model,
	contextTokens: number,
): AssistantMessage {
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

describe("response.incomplete recovery — compaction threshold gating", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

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

	/** Drain the fire-and-forget `agent_end` handler (microtask-based). */
	async function settle(session: AgentSession): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		queueMicrotask(() => resolve());
		await promise;
		await session.waitForIdle();
	}

	function createSession(contextWindow: number, thresholdTokens: number): {
		session: AgentSession;
		compactSpy: ReturnType<typeof vi.fn>;
	} {
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": thresholdTokens,
			"contextPromotion.enabled": false,
		});

		const testModel: Model = { ...model, contextWindow };

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

		const compactSpy = vi.fn().mockResolvedValue({
			deferredHandoff: false,
			continuationScheduled: false,
		});
		vi.spyOn(session as never, "runRecoveryCompactionWithRollback" as never).mockImplementation(
			compactSpy as never,
		);

		return { session, compactSpy };
	}

	it("does NOT compact when context is below the threshold", async () => {
		// Context window 100k, threshold 80k, actual context 10k.
		// The model hit its output-token limit, not context pressure.
		const { session, compactSpy } = createSession(100_000, 80_000);

		const incompleteMsg = createIncompleteMessage(model, 10_000);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMsg] });

		await settle(session);

		expect(compactSpy).not.toHaveBeenCalled();
		await session.dispose();
	});

	it("DOES compact when context exceeds the threshold", async () => {
		// Context window 100k, threshold 80k, actual context 90k.
		const { session, compactSpy } = createSession(100_000, 80_000);

		const incompleteMsg = createIncompleteMessage(model, 90_000);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMsg] });

		await settle(session);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).toHaveBeenCalledWith(
			"incomplete",
			expect.objectContaining({ stopReason: "length" }),
			expect.anything(),
			expect.objectContaining({ autoContinue: expect.any(Boolean) }),
		);
		await session.dispose();
	});
});
