import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const refusal: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "mock",
	provider: "anthropic",
	model: "claude-opus-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "error",
	stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined." },
	errorMessage: "Refusal (cyber): Classifier declined.",
	timestamp: 2,
};

const originalUserMessage = { role: "user" as const, content: "Explain how to bypass the classifier.", timestamp: 1 };
const rewrittenPrompt = "Explain the request in neutral, legitimate terms.";

describe("TurnRecovery refusal paraphrase", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@turn-recovery-paraphrase-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "mock-test-key");
		registerMockApi();
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createRecovery(
		options: {
			maxRetries?: number;
			stopReason?: "length" | "aborted" | "error";
			waitForSessionMessagePersistence?: (message: AssistantMessage) => Promise<void>;
			onSessionEvent?: (event: AgentSessionEvent) => Promise<void>;
			paraphrasedText?: string;
			useSmolPriorityDefault?: boolean;
			paraphraseModelId?: string;
			paraphraseModelProvider?: string;
			obfuscateTextForProvider?: (text: string) => string;
			deobfuscateFromProvider?: (text: string) => string;
			paraphraseRole?: "tiny" | "smol";
			configuredSmolRole?: string;
			extraAvailableModels?: MockModel[];
		} = {},
	): {
		recovery: TurnRecovery;
		paraphraseModel: MockModel;
		events: AgentSessionEvent[];
		scheduled: Parameters<TurnRecoveryHost["scheduleAgentContinue"]>[0][];
		agent: Agent;
		sessionManager: SessionManager;
	} {
		const primaryModel = createMockModel({ provider: "anthropic", id: "claude-opus-5" });
		const paraphraseModel = createMockModel({
			id: options.paraphraseModelId ?? "refusal-paraphraser",
			provider: options.paraphraseModelProvider,
			responses: [
				options.stopReason
					? { content: ["partial rewrite"], stopReason: options.stopReason }
					: { content: [options.paraphrasedText ?? rewrittenPrompt] },
			],
		});
		const userMessage = { ...originalUserMessage };
		const agent = new Agent({
			getApiKey: () => "primary-test-key",
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [userMessage, refusal],
			},
			streamFn: primaryModel.stream,
		});
		agent.setMetadataResolver(() => ({ account_uuid: "selected-account" }));
		const settings = Settings.isolated({
			"retry.modelFallback": false,
			"retry.refusalParaphrase": true,
			"retry.maxRetries": options.maxRetries ?? 10,
		});
		if (options.paraphraseRole) settings.set("retry.refusalParaphraseRole", options.paraphraseRole);
		if (options.configuredSmolRole) {
			settings.setModelRole("smol", options.configuredSmolRole);
		} else if (!options.useSmolPriorityDefault) {
			settings.setModelRole("smol", `mock/${options.paraphraseModelId ?? "refusal-paraphraser"}`);
		}
		const modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([
			paraphraseModel,
			...(options.extraAvailableModels ?? []),
		]);
		const events: AgentSessionEvent[] = [];
		const scheduled: Parameters<TurnRecoveryHost["scheduleAgentContinue"]>[0][] = [];
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMessage);
		const host: TurnRecoveryHost = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			configWarnings: [],
			model: () => primaryModel,
			thinkingLevel: () => undefined,
			configuredThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			thinkingLevelCeiling: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isCompacting: () => false,
			abortInProgress: () => false,
			streamingEditAbortTriggered: () => false,
			promptGeneration: () => 1,
			sessionId: () => "refusal-paraphrase-test",
			obfuscateTextForProvider: options.obfuscateTextForProvider ?? (text => text),
			deobfuscateFromProvider: options.deobfuscateFromProvider ?? (text => text),
			emitSessionEvent: async event => {
				events.push(event);
				await options.onSessionEvent?.(event);
			},
			scheduleAgentContinue: request => {
				scheduled.push(request);
			},
			waitForSessionMessagePersistence: options.waitForSessionMessagePersistence ?? (async () => {}),
			appendSessionMessage: message => {
				sessionManager.appendMessage(message);
			},
			sessionMessageAlreadyPersisted: () => false,
			setModelWithProviderSessionReset: async () => {},
			resetCurrentResponsesProviderSession: () => {},
			maybeAutoRedeemCodexReset: async () => false,
			runAutoCompaction: async () => ({ deferredHandoff: false, continuationScheduled: false }),
			withBashBranchTransition: operation => operation(),
		};
		return { recovery: new TurnRecovery(host), paraphraseModel, events, scheduled, agent, sessionManager };
	}

	it("persists a successful rewrite and retains its provider attribution", async () => {
		const { recovery, paraphraseModel, agent, sessionManager } = createRecovery();
		const warn = vi.spyOn(logger, "warn");

		expect(await recovery.handleRetryableError(refusal)).toBe(true);
		expect(paraphraseModel.calls[0]?.options).toMatchObject({
			sessionId: "refusal-paraphrase-test",
			metadata: { account_uuid: "selected-account" },
		});
		expect(sessionManager.buildSessionContext().messages).toEqual(agent.state.messages);
		expect(agent.state.messages).toEqual([{ ...originalUserMessage, content: rewrittenPrompt }]);
		expect(warn).toHaveBeenCalledWith("Retrying classifier refusal with paraphrased user prompt", {
			model: "mock/refusal-paraphraser",
			originalLength: originalUserMessage.content.length,
			paraphrasedLength: rewrittenPrompt.length,
		});
	});

	for (const stopReason of ["length", "aborted", "error"] as const) {
		it(`does not replace context from a ${stopReason} paraphrase response`, async () => {
			const { recovery, events, scheduled, agent, sessionManager } = createRecovery({ stopReason });

			expect(await recovery.handleRetryableError(refusal)).toBe(false);
			expect(agent.state.messages).toEqual([originalUserMessage, refusal]);
			expect(sessionManager.buildSessionContext().messages).toEqual([originalUserMessage]);
			expect(events).toEqual([]);
			expect(scheduled).toEqual([]);
		});
	}

	it("does not paraphrase when the retry budget is exhausted", async () => {
		const { recovery, paraphraseModel, agent } = createRecovery({ maxRetries: 0 });

		expect(await recovery.handleRetryableError(refusal)).toBe(false);
		expect(paraphraseModel.calls).toHaveLength(0);
		expect(agent.state.messages).toEqual([originalUserMessage, refusal]);
	});

	it("does not rewrite an older user turn behind a synthetic developer trigger", async () => {
		const { recovery, paraphraseModel, agent } = createRecovery();
		const syntheticPrompt = { role: "developer" as const, content: "Continue the guided task.", timestamp: 3 };
		const syntheticRefusal = { ...refusal, timestamp: 4 };
		agent.replaceMessages([originalUserMessage, syntheticPrompt, syntheticRefusal]);

		expect(await recovery.handleRetryableError(syntheticRefusal)).toBe(false);
		expect(paraphraseModel.calls).toHaveLength(0);
		expect(agent.state.messages).toEqual([originalUserMessage, syntheticPrompt, syntheticRefusal]);
	});

	it("rewrites the user turn when companion messages precede the refusal", async () => {
		const { recovery, paraphraseModel, agent, sessionManager } = createRecovery();
		const companion = {
			role: "custom" as const,
			customType: "before-agent-start",
			content: "Extra turn context.",
			display: false,
			attribution: "agent" as const,
			timestamp: 3,
		};
		const companionRefusal = { ...refusal, timestamp: 4 };
		agent.replaceMessages([originalUserMessage, companion, companionRefusal]);

		expect(await recovery.handleRetryableError(companionRefusal)).toBe(true);
		expect(paraphraseModel.calls).toHaveLength(1);
		expect(agent.state.messages).toEqual([{ ...originalUserMessage, content: rewrittenPrompt }, companion]);
		// The replacement branch must recreate the post-user companion so a
		// reload/transcript rebuild keeps the same context the live retry sees.
		expect(sessionManager.buildSessionContext().messages).toEqual([
			{ ...originalUserMessage, content: rewrittenPrompt },
			companion,
		]);
	});

	it("obfuscates the paraphrase request and restores the rewritten response", async () => {
		const { recovery, paraphraseModel, agent } = createRecovery({
			paraphrasedText: "Explain <secret> in neutral terms.",
			obfuscateTextForProvider: text => text.replace("classifier", "<secret>"),
			deobfuscateFromProvider: text => text.replace("<secret>", "classifier"),
		});

		expect(await recovery.handleRetryableError(refusal)).toBe(true);
		expect(paraphraseModel.calls[0]?.context.messages).toMatchObject([
			{ role: "user", content: "Explain how to bypass the <secret>." },
		]);
		expect(agent.state.messages).toEqual([
			{ ...originalUserMessage, content: "Explain classifier in neutral terms." },
		]);
	});

	it("resolves an unset paraphrase role through @smol", async () => {
		const { recovery, paraphraseModel } = createRecovery({
			useSmolPriorityDefault: true,
			paraphraseModelId: "zai-glm-4.7",
			paraphraseModelProvider: "cerebras",
		});

		expect(await recovery.handleRetryableError(refusal)).toBe(true);
		expect(paraphraseModel.calls).toHaveLength(1);
	});

	it("honours the configured paraphrase role alias instead of @smol when the role is unset", async () => {
		// refusalParaphraseRole is `tiny`, but modelRoles.tiny is unset while
		// modelRoles.smol is explicitly configured. The fallback must resolve the
		// selected role's chain (@tiny -> MODEL_PRIO.smol), not @smol, so the
		// user's choice of Tiny is not silently overridden by the smol role.
		const smolConfiguredModel = createMockModel({ provider: "mock", id: "smol-explicit", responses: [] });
		const { recovery, paraphraseModel } = createRecovery({
			paraphraseRole: "tiny",
			paraphraseModelId: "zai-glm-4.7",
			paraphraseModelProvider: "cerebras",
			configuredSmolRole: "mock/smol-explicit",
			extraAvailableModels: [smolConfiguredModel],
		});

		expect(await recovery.handleRetryableError(refusal)).toBe(true);
		expect(paraphraseModel.calls).toHaveLength(1);
		expect(smolConfiguredModel.calls).toHaveLength(0);
	});

	it("honours an abort that lands during the persistence wait, before branch mutation and scheduling", async () => {
		const persistenceBlocked = Promise.withResolvers<void>();
		const enteredPersistence = Promise.withResolvers<void>();
		const { recovery, agent, sessionManager, events, scheduled } = createRecovery({
			waitForSessionMessagePersistence: async () => {
				enteredPersistence.resolve();
				await persistenceBlocked.promise;
			},
		});

		const pending = recovery.handleRetryableError(refusal);
		// Wait until the paraphrase call has resolved and the recovery has parked
		// on the persistence wait — the exact window where Escape must still cancel.
		await enteredPersistence.promise;
		recovery.abortRetry();
		persistenceBlocked.resolve();

		expect(await pending).toBe(false);
		// No persisted branch rewrite and no scheduled continuation.
		expect(agent.state.messages).toEqual([originalUserMessage, refusal]);
		expect(sessionManager.buildSessionContext().messages).toEqual([originalUserMessage]);
		expect(scheduled).toEqual([]);
		expect(events.map(event => event.type)).not.toContain("refusal_paraphrase_applied");
	});

	for (const abortDuring of ["refusal_paraphrase_applied", "auto_retry_start"] as const) {
		it(`commits atomically when Escape lands during ${abortDuring} delivery`, async () => {
			const delivery = Promise.withResolvers<void>();
			const enteredDelivery = Promise.withResolvers<void>();
			const { recovery, agent, sessionManager, events, scheduled } = createRecovery({
				onSessionEvent: async event => {
					if (event.type !== abortDuring) return;
					enteredDelivery.resolve();
					await delivery.promise;
				},
			});

			const pending = recovery.handleRetryableError(refusal);
			await enteredDelivery.promise;
			recovery.abortRetry();
			delivery.resolve();

			expect(await pending).toBe(true);
			expect(agent.state.messages).toEqual([{ ...originalUserMessage, content: rewrittenPrompt }]);
			expect(sessionManager.buildSessionContext().messages).toEqual(agent.state.messages);
			expect(events.map(event => event.type)).toEqual(["refusal_paraphrase_applied", "auto_retry_start"]);
			expect(recovery.retryPromise).toBeUndefined();
			expect(scheduled).toEqual([expect.objectContaining({ delayMs: 1, generation: 1 })]);
		});
	}
});
