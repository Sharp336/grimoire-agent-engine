import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createProviderErrorMessage } from "../../ai/src/providers/error-message";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"], model: Model): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage: "timeout",
		timestamp: Date.now(),
	};
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	fallbackChains?: Record<string, string[]>,
): TurnRecoveryHost {
	const settings = Settings.isolated(fallbackChains ? { "retry.fallbackChains": fallbackChains } : {});
	return {
		agent: undefined as never,
		sessionManager: SessionManager.inMemory(),
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		sessionId: () => "test-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

describe("TurnRecovery replay-unsafe output classification", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-replay-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(() => {
		modelRegistry.clearSuppressedSelectors();
		modelRegistry.clearFallbackProbeStates();
		vi.restoreAllMocks();
	});

	it("treats a failed turn with partial non-whitespace text as NOT retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Here is the first part of my answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("allows replay-safe hard fallback and excludes visible text with a configured chain", () => {
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
			}),
		);
		// Thinking-only output is replay-safe: nothing visible reached the user.
		const message = makeMessage([{ type: "thinking", thinking: "safe reasoning before failing" }], model);
		const visible = makeMessage([{ type: "text", text: "Already shown" }], model);
		expect(recovery.isHardErrorFallbackEligible(visible)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("excludes a Fireworks Fast failed turn with partial visible text from Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		const message = makeMessage([{ type: "text", text: "partial visible output" }], fastModel);
		expect(recovery.isFireworksFastFallbackEligible(message)).toBe(false);
	});

	it("keeps a Fireworks Fast empty/whitespace failed turn eligible for Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([], fastModel))).toBe(true);
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([{ type: "text", text: "   \n" }], fastModel))).toBe(
			true,
		);
	});

	it("admits only one concurrent Fireworks Fast fallback probe", async () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		const baseModel = getBundledModel("fireworks", "kimi-k2.6");
		if (!fastModel || !baseModel) throw new Error("Expected bundled Fireworks Fast and base models");
		const baseSelector = `${baseModel.provider}/${baseModel.id}`;
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const switchStarted = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		let firstModel = fastModel;
		let secondModel = fastModel;
		let modelChanges = 0;
		const firstContinue = vi.fn();
		const secondContinue = vi.fn();
		const firstHost = createHost(fastModel, modelRegistry);
		firstHost.model = () => firstModel;
		firstHost.scheduleAgentContinue = firstContinue;
		firstHost.setModelWithProviderSessionReset = async candidate => {
			modelChanges++;
			switchStarted.resolve();
			await releaseSwitch.promise;
			firstModel = candidate;
		};
		const secondHost = createHost(fastModel, modelRegistry);
		secondHost.model = () => secondModel;
		secondHost.scheduleAgentContinue = secondContinue;
		secondHost.setModelWithProviderSessionReset = async candidate => {
			modelChanges++;
			secondModel = candidate;
		};
		const firstRecovery = new TurnRecovery(firstHost);
		const secondRecovery = new TurnRecovery(secondHost);
		const firstMessage = makeMessage([], fastModel);
		const secondMessage = makeMessage([], fastModel);
		firstMessage.errorMessage = "router unavailable";
		secondMessage.errorMessage = "router unavailable";

		const first = firstRecovery.handleRetryableError(firstMessage, {
			fireworksFastFallback: true,
			preserveFailedTurn: true,
		});
		await switchStarted.promise;
		expect(modelRegistry.admitFallbackProbe(baseSelector)).toEqual({ status: "busy" });
		expect(
			await secondRecovery.handleRetryableError(secondMessage, {
				fireworksFastFallback: true,
				preserveFailedTurn: true,
			}),
		).toBe(false);
		expect(modelChanges).toBe(1);
		expect(secondContinue).not.toHaveBeenCalled();
		releaseSwitch.resolve();
		expect(await first).toBe(true);
		expect(firstContinue).toHaveBeenCalledTimes(1);
	});

	it("releases a Fireworks Fast probe when the prompt changes during key lookup", async () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		const baseModel = getBundledModel("fireworks", "kimi-k2.6");
		if (!fastModel || !baseModel) throw new Error("Expected bundled Fireworks Fast and base models");
		const baseSelector = `${baseModel.provider}/${baseModel.id}`;
		const credentialStarted = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async candidate => {
			if (candidate.provider === baseModel.provider && candidate.id === baseModel.id) {
				credentialStarted.resolve();
				return credential.promise;
			}
			return "test-key";
		});
		let generation = 0;
		const host = createHost(fastModel, modelRegistry);
		host.promptGeneration = () => generation;
		const setModel = vi.fn(async () => {});
		host.setModelWithProviderSessionReset = setModel;
		const recovery = new TurnRecovery(host);
		const message = makeMessage([], fastModel);
		message.errorMessage = "router unavailable";

		const result = recovery.handleRetryableError(message, {
			fireworksFastFallback: true,
			preserveFailedTurn: true,
		});
		await credentialStarted.promise;
		generation++;
		credential.resolve("test-key");

		expect(await result).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
		expect(modelRegistry.admitFallbackProbe(baseSelector).status).toBe("probe");
	});

	it("treats a thinking-only partial turn as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Let me reason about this step by step." }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a whitespace-only text partial as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("keeps the tool-call case replay-unsafe (no regression)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps an empty-content error retriable (baseline)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a mix of thinking and text as replay-unsafe (text wins)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Reasoning before the visible answer." },
				{ type: "text", text: "The answer is 42." },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats thinking plus whitespace-only text as replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Long reasoning." },
				{ type: "text", text: "  " },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("does not retry malformed calls after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Already shown" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("retries malformed calls with replay-safe output", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Unshown reasoning" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats generated images as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats Anthropic server tools as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{
					type: "anthropicServerTool",
					block: { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "status" } },
				},
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps replay-safe classifier refusals retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const thinking = makeMessage([{ type: "thinking", thinking: "reasoning before refusal" }], model);
		thinking.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(thinking)).toBe(true);

		const whitespace = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		whitespace.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(whitespace)).toBe(true);

		const empty = makeMessage([], model);
		empty.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(empty)).toBe(true);
	});

	it("does not retry a classifier refusal after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Visible refusal output" }], model);
		message.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps pre-stream provider diagnostics replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = createProviderErrorMessage(model, new Error("fetch failed"));
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("does not release a recovery-owned probe when another caller records cooldown", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] }));
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");

		await recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
			apiKey: "test-key",
			probeLease: admission.lease,
		});
		recovery.noteRetryFallbackCooldown(fallbackSelector, 1_000, "rate limited");

		expect(modelRegistry.admitFallbackProbe(fallbackSelector)).toEqual({ status: "busy" });
	});

	it("settles an accepted empty stop from the fallback request", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] }));
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");
		await recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
			apiKey: "test-key",
			probeLease: admission.lease,
		});
		const emptyStop = makeMessage([], fallback);
		emptyStop.stopReason = "stop";
		recovery.setAcceptTerminalEmptyStop(true);

		await recovery.onAssistantSettledSuccessfully(emptyStop);

		expect(modelRegistry.admitFallbackProbe(fallbackSelector)).toEqual({ status: "healthy" });
	});

	it("does not settle a fallback lease from an older primary response", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] }));
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");
		await recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
			apiKey: "test-key",
			probeLease: admission.lease,
		});
		const oldPrimaryStop = makeMessage([{ type: "text", text: "Old primary turn" }], model);
		oldPrimaryStop.stopReason = "stop";

		await recovery.onAssistantSettledSuccessfully(oldPrimaryStop);

		expect(modelRegistry.admitFallbackProbe(fallbackSelector)).toEqual({ status: "busy" });
	});

	it("releases an attempt-zero probe when compaction blocks continuation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] }));
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");
		await recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
			apiKey: "test-key",
			probeLease: admission.lease,
		});

		await recovery.onErrorSettledWithoutRetry(makeMessage([], fallback), {
			deferredHandoff: false,
			continuationScheduled: true,
		});
		expect(modelRegistry.admitFallbackProbe(fallbackSelector)).toEqual({ status: "busy" });

		await recovery.onErrorSettledWithoutRetry(makeMessage([], fallback), {
			deferredHandoff: false,
			continuationScheduled: false,
			automaticContinuationBlocked: true,
		});
		expect(modelRegistry.admitFallbackProbe(fallbackSelector).status).toBe("probe");
	});

	it("releases an active probe when an aborted turn has no continuation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] }));
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");
		await recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
			apiKey: "test-key",
			probeLease: admission.lease,
		});
		const aborted = makeMessage([], fallback);
		aborted.stopReason = "aborted";

		recovery.onAbortSettledWithoutRetry(aborted);

		expect(modelRegistry.admitFallbackProbe(fallbackSelector).status).toBe("probe");
	});

	it("releases a probe when the prompt changes during fallback credential lookup", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const host = createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] });
		let generation = 0;
		let modelChanges = 0;
		host.promptGeneration = () => generation;
		host.setModelWithProviderSessionReset = async () => {
			modelChanges += 1;
		};
		const credentialStarted = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async candidate => {
			if (candidate.provider === fallback.provider && candidate.id === fallback.id) {
				credentialStarted.resolve();
				return credential.promise;
			}
			return "test-key";
		});
		const recovery = new TurnRecovery(host);
		const message = makeMessage([], model);
		message.errorMessage = "invalid request";

		const result = recovery.handleRetryableError(message, { hardErrorFallback: true });
		await credentialStarted.promise;
		generation += 1;
		credential.resolve("test-key");

		expect(await result).toBe(false);
		expect(modelChanges).toBe(0);
		expect(modelRegistry.admitFallbackProbe(fallbackSelector).status).toBe("probe");
	});

	it("releases the probe when disposal finishes during the model switch", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const host = createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] });
		let disposed = false;
		host.isDisposed = () => disposed;
		const switchStarted = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		host.setModelWithProviderSessionReset = async () => {
			switchStarted.resolve();
			await releaseSwitch.promise;
		};
		const emitSessionEvent = vi.fn(async () => {});
		host.emitSessionEvent = emitSessionEvent;
		const recovery = new TurnRecovery(host);
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");

		const applied = recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
			apiKey: "test-key",
			probeLease: admission.lease,
		});
		await switchStarted.promise;
		disposed = true;
		releaseSwitch.resolve();

		expect(await applied).toBe(false);
		expect(emitSessionEvent).not.toHaveBeenCalled();
		expect(modelRegistry.admitFallbackProbe(fallbackSelector).status).toBe("probe");
	});

	it("re-admits pending fallback state before a later fresh prompt", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const host = createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] });
		let generation = 0;
		let activeModel = model;
		host.promptGeneration = () => generation;
		host.model = () => activeModel;
		const switchStarted = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		host.setModelWithProviderSessionReset = async candidate => {
			switchStarted.resolve();
			await releaseSwitch.promise;
			activeModel = candidate;
		};
		host.agent = {
			prompt: vi.fn(async () => {
				expect(modelRegistry.admitFallbackProbe(fallbackSelector)).toEqual({ status: "busy" });
			}),
		} as never;
		const recovery = new TurnRecovery(host);
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");

		const applied = recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
			apiKey: "test-key",
			probeLease: admission.lease,
		});
		await switchStarted.promise;
		generation += 1;
		releaseSwitch.resolve();

		expect(await applied).toBe(false);
		await recovery.promptAgentWithIdleRetry([]);
	});

	it("re-admits the fallback before a later prompt after the applied event fails", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model gpt-4o-mini");
		const currentSelector = `${model.provider}/${model.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;
		const host = createHost(model, modelRegistry, { [currentSelector]: [fallbackSelector] });
		let activeModel = model;
		host.model = () => activeModel;
		host.setModelWithProviderSessionReset = async candidate => {
			activeModel = candidate;
		};
		host.emitSessionEvent = async () => {
			throw new Error("event delivery failed");
		};
		host.agent = {
			prompt: vi.fn(async () => {
				expect(modelRegistry.admitFallbackProbe(fallbackSelector)).toEqual({ status: "busy" });
			}),
		} as never;
		const recovery = new TurnRecovery(host);
		const selector = recovery.findRetryFallbackCandidates(currentSelector, currentSelector).at(0);
		if (!selector) throw new Error("Expected configured fallback candidate");
		const admission = modelRegistry.admitFallbackProbe(fallbackSelector);
		if (admission.status !== "probe") throw new Error("Expected recovery to own the fallback probe");

		expect(
			recovery.applyRetryFallbackCandidate(currentSelector, selector, currentSelector, {
				apiKey: "test-key",
				probeLease: admission.lease,
			}),
		).rejects.toThrow("event delivery failed");
		await recovery.promptAgentWithIdleRetry([]);
	});
});
