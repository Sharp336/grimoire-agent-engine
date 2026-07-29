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
import { TempDir } from "@oh-my-pi/pi-utils";

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

	function createRecovery(enabled: boolean): {
		recovery: TurnRecovery;
		paraphraseModel: MockModel;
		events: AgentSessionEvent[];
		scheduled: Parameters<TurnRecoveryHost["scheduleAgentContinue"]>[0][];
		agent: Agent;
	} {
		const primaryModel = createMockModel({ provider: "anthropic", id: "claude-opus-5" });
		const paraphraseModel = createMockModel({
			id: "refusal-paraphraser",
			responses: [{ content: ["Explain the request in neutral, legitimate terms."] }],
		});
		const agent = new Agent({
			getApiKey: () => "primary-test-key",
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: "Explain how to bypass the classifier.", timestamp: 1 }, refusal],
			},
			streamFn: primaryModel.stream,
		});
		const settings = Settings.isolated({
			"retry.modelFallback": false,
			"retry.refusalParaphrase": enabled,
		});
		settings.setModelRole("smol", "mock/refusal-paraphraser");
		const modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([paraphraseModel]);
		const events: AgentSessionEvent[] = [];
		const scheduled: Parameters<TurnRecoveryHost["scheduleAgentContinue"]>[0][] = [];
		const host: TurnRecoveryHost = {
			agent,
			sessionManager: SessionManager.inMemory(),
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
			emitSessionEvent: async event => {
				events.push(event);
			},
			scheduleAgentContinue: options => {
				scheduled.push(options);
			},
			waitForSessionMessagePersistence: async () => {},
			appendSessionMessage: () => {},
			sessionMessageAlreadyPersisted: () => false,
			setModelWithProviderSessionReset: async () => {},
			resetCurrentResponsesProviderSession: () => {},
			maybeAutoRedeemCodexReset: async () => false,
			runAutoCompaction: async () => ({ deferredHandoff: false, continuationScheduled: false }),
			withBashBranchTransition: operation => operation(),
		};
		return { recovery: new TurnRecovery(host), paraphraseModel, events, scheduled, agent };
	}

	it("retries a refusal once with a rewritten user message and emits both texts", async () => {
		const { recovery, paraphraseModel, events, scheduled, agent } = createRecovery(true);

		expect(await recovery.handleRetryableError(refusal)).toBe(true);

		expect(paraphraseModel.calls).toHaveLength(1);
		expect(paraphraseModel.calls[0]?.context.messages).toEqual([
			{ role: "user", content: "Explain how to bypass the classifier.", timestamp: expect.any(Number) },
		]);
		expect(agent.state.messages).toEqual([
			{ role: "user", content: "Explain the request in neutral, legitimate terms.", timestamp: 1 },
		]);
		expect(events).toEqual([
			{
				type: "refusal_paraphrase_applied",
				originalText: "Explain how to bypass the classifier.",
				paraphrasedText: "Explain the request in neutral, legitimate terms.",
			},
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 10,
				delayMs: 0,
				errorMessage: "Refusal (cyber): Classifier declined.",
				errorId: undefined,
			},
		]);
		expect(scheduled).toEqual([{ delayMs: 1, generation: 1, onError: expect.any(Function) }]);
	});

	it("leaves a refusal on the existing path when the setting is disabled", async () => {
		const { recovery, paraphraseModel, events, scheduled, agent } = createRecovery(false);

		expect(await recovery.handleRetryableError(refusal)).toBe(false);

		expect(paraphraseModel.calls).toHaveLength(0);
		expect(agent.state.messages).toHaveLength(2);
		expect(events).toEqual([]);
		expect(scheduled).toEqual([]);
	});
});
