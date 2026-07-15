import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession context promotion", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		// ModelRegistry eagerly loads the immutable bundled model catalog in its
		// constructor (~100ms). The catalog and auth fixture never change between
		// tests here (tests only read models and add benign extra runtime keys),
		// so build them once instead of paying ~950ms across the 9 cases.
		tempDir = TempDir.createSync("@pi-context-promotion-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		vi.restoreAllMocks();
	});

	function createOverflowMessage(
		model: Model,
		errorMessage = "context_length_exceeded: Your input exceeds the context window of this model.",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}

	function createIncompleteMessage(model: Model): AssistantMessage {
		// Mirrors what the codex/responses provider produces for `response.incomplete`:
		// stopReason "length", reasoning-only content, no actionable deliverable.
		return {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	function createUserMessage(content: string) {
		return {
			role: "user" as const,
			content,
			timestamp: Date.now(),
		};
	}

	function createAssistantMessage(model: Model, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for condition");
	}

	// Deterministically drain the fire-and-forget `agent_end` handler that
	// `emitExternalEvent` dispatches. The handler's terminal maintenance work
	// (`#checkCompaction`) is microtask-based on the no-promotion paths, so a
	// single macrotask turn fully flushes it; `waitForIdle` then settles any
	// tracked continuation. Used by the negative tests, which assert that *no*
	// promotion happened and therefore need the handler to have actually run.
	async function settle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
		await session.waitForIdle();
	}

	it("promotes to a larger-context model on overflow and clears codex websocket session state", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("promotes on 413 payload-too-large overflow errors", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(
			sparkModel,
			"413 Request Entity Too Large: payload too large for model request body",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
	});
	it("clears codex provider session state on manual setModel switch away from codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModel(nonCodexModel);

		expect(session.model?.provider).toBe(nonCodexModel.provider);
		expect(session.model?.id).toBe(nonCodexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state on manual temporary switch into codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: nonCodexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModelTemporary(codexModel);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when branching rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.branch(firstUserId);

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when tree navigation rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.navigateTree(firstUserId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("does not promote when promotion is disabled", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!sparkModel) {
			throw new Error("Expected codex spark model to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(sparkModel.provider);
		expect(session.model?.id).toBe(sparkModel.id);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
	});

	it("does not promote by default", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!sparkModel) {
			throw new Error("Expected codex spark model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(sparkModel.provider);
		expect(session.model?.id).toBe(sparkModel.id);
	});

	it("falls back to LLM compaction when snapcompact cannot run during overflow recovery", async () => {
		const model = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!model) {
			throw new Error("Expected codex spark model to exist");
		}
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "snapcompact",
			"compaction.keepRecentTokens": 1,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "fallback summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.sessionManager.appendMessage(createUserMessage("old context ".repeat(80_000)));
		session.sessionManager.appendMessage(createAssistantMessage(model, "old response"));
		session.sessionManager.appendMessage(createUserMessage("current request"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const events: Array<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = [];
		const compactionDone = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				events.push(event);
				compactionDone.resolve();
			}
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const overflowMessage = createOverflowMessage(model);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await compactionDone.promise;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(events[0]?.errorMessage).toBeUndefined();
		expect(events[0]?.willRetry).toBe(true);
		await waitFor(() => continueSpy.mock.calls.length === 1);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("promotes to a larger-context model on response.incomplete (length stop)", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const incompleteMessage = createIncompleteMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
	});

	it("does not promote on length stop when message is from a different model", async () => {
		// Switching from a small-context model to a larger one and then receiving a
		// stale length-stop event for the previous model must NOT trigger promotion
		// or compaction on the new model — same guard as the overflow path.
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Stale incomplete from the smaller model — current session is already on codex.
		const staleIncomplete = createIncompleteMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: staleIncomplete });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [staleIncomplete] });

		await settle();

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
	});

	it("compares candidate effective budget and skips promotion if effective budget is not larger", async () => {
		const gpt55 = modelRegistry.find("openai-codex", "gpt-5.5");
		const luna = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		if (!gpt55 || !luna) {
			throw new Error("Expected gpt-5.5 and gpt-5.6-luna to exist");
		}
		const originalLunaContextWindow = luna.contextWindow;
		const originalLunaDefaultContextTokens = luna.defaultContextTokens;
		luna.contextWindow = 372_000;
		luna.defaultContextTokens = 272_000;

		// Mutate promotion target to point to luna
		const originalTarget = gpt55.contextPromotionTarget;
		gpt55.contextPromotionTarget = "openai-codex/gpt-5.6-luna";

		try {
			// Under default context budget percent (-1):
			// gpt-5.5 has 272k budget.
			// luna has 272k budget (defaultContextTokens).
			// They are equal, so promotion should be skipped!
			const settingsDefault = Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": true,
				"context.windowBudgetPercent": -1,
			});

			const agent1 = new Agent({
				initialState: {
					model: gpt55,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});

			const sessionDefault = new AgentSession({
				agent: agent1,
				sessionManager: SessionManager.inMemory(),
				settings: settingsDefault,
				modelRegistry,
			});

			const overflowMsg = createOverflowMessage(gpt55);
			sessionDefault.agent.emitExternalEvent({ type: "message_end", message: overflowMsg });
			sessionDefault.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMsg] });

			await settle();

			// Should NOT have promoted
			expect(sessionDefault.model?.id).toBe("gpt-5.5");
			await sessionDefault.dispose();

			// Under 100% budget percent:
			// gpt-5.5 has 272k budget.
			// luna has 372k budget (contextWindow).
			// 372k > 272k, so promotion should succeed!
			const settings100 = Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": true,
				"context.windowBudgetPercent": 100,
			});

			const agent2 = new Agent({
				initialState: {
					model: gpt55,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});

			const session100 = new AgentSession({
				agent: agent2,
				sessionManager: SessionManager.inMemory(),
				settings: settings100,
				modelRegistry,
			});

			const overflowMsg2 = createOverflowMessage(gpt55);
			session100.agent.emitExternalEvent({ type: "message_end", message: overflowMsg2 });
			session100.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMsg2] });

			await settle();

			// Should have promoted to luna
			expect(session100.model?.id).toBe("gpt-5.6-luna");
			await session100.dispose();
		} finally {
			gpt55.contextPromotionTarget = originalTarget;
			luna.contextWindow = originalLunaContextWindow;
			luna.defaultContextTokens = originalLunaDefaultContextTokens;
		}
	});
	it("reapplies a changed budget from the canonical model capacity", async () => {
		const luna = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		if (!luna) {
			throw new Error("Expected gpt-5.6-luna to exist");
		}
		const originalContextWindow = luna.contextWindow;
		const originalDefaultContextTokens = luna.defaultContextTokens;
		luna.contextWindow = 372_000;
		luna.defaultContextTokens = 272_000;

		let budgetSession: AgentSession | undefined;
		try {
			const settings = Settings.isolated();
			const agent = new Agent({
				initialState: {
					model: luna,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});
			budgetSession = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			expect(budgetSession.model?.contextWindow).toBe(272_000);
			expect(modelRegistry.find("openai-codex", "gpt-5.6-luna")?.contextWindow).toBe(372_000);

			settings.set("context.windowBudgetPercent", 100);
			expect(settings.get("context.windowBudgetPercent")).toBe(100);
			expect(modelRegistry.find("openai-codex", "gpt-5.6-luna")?.contextWindow).toBe(372_000);
			const setModelSpy = vi.spyOn(budgetSession.agent, "setModel");
			budgetSession.reapplyContextBudget();
			expect(setModelSpy).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 372_000 }));
			expect(budgetSession.model?.contextWindow).toBe(372_000);
			expect(budgetSession.model?.maxTokens).toBe(128_000);

			settings.set("context.windowBudgetPercent", 50);
			budgetSession.reapplyContextBudget();
			expect(budgetSession.model?.contextWindow).toBe(186_000);
		} finally {
			luna.contextWindow = originalContextWindow;
			luna.defaultContextTokens = originalDefaultContextTokens;
			await budgetSession?.dispose();
		}
	});
	it("restores a failed session switch from canonical capacity without reducing the budget twice", async () => {
		const luna = modelRegistry.find("openai-codex", "gpt-5.6-luna");
		const targetModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!luna || !targetModel) {
			throw new Error("Expected gpt-5.6-luna and gpt-5.5 to exist");
		}
		const originalContextWindow = luna.contextWindow;
		const originalDefaultContextTokens = luna.defaultContextTokens;
		luna.contextWindow = 372_000;
		luna.defaultContextTokens = 272_000;

		try {
			const settings = Settings.isolated({ "context.windowBudgetPercent": 50 });
			const agent = new Agent({
				initialState: {
					model: luna,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "rollback-active")),
				settings,
				modelRegistry,
			});
			expect(session.model?.contextWindow).toBe(186_000);

			const targetSessionFile = path.join(tempDir.path(), "rollback-target.jsonl");
			const timestamp = "2026-07-15T00:00:00.000Z";
			await Bun.write(
				targetSessionFile,
				`${[
					{ type: "session", version: 3, id: "rollback-target", timestamp, cwd: tempDir.path() },
					{
						type: "model_change",
						id: "target-model",
						parentId: null,
						timestamp,
						model: `${targetModel.provider}/${targetModel.id}`,
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`,
			);
			vi.spyOn(session.agent, "setThinkingLevel").mockImplementationOnce(() => {
				throw new Error("forced switch failure");
			});

			await expect(session.switchSession(targetSessionFile)).rejects.toThrow("forced switch failure");
			expect(session.model?.id).toBe(luna.id);
			expect(session.model?.contextWindow).toBe(186_000);
		} finally {
			luna.contextWindow = originalContextWindow;
			luna.defaultContextTokens = originalDefaultContextTokens;
		}
	});
});
