import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, CommittedResetSessionContextError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionMemory } from "@oh-my-pi/pi-coding-agent/session/session-memory";

const STALE_FIRST_TURN_GUIDANCE = "## First-Response Planning Check\n\nStale guidance";
const REBUILT_SYSTEM_PROMPT = "Rebuilt prompt without first-turn guidance";

interface RebuildGate {
	calls: number;
	error?: Error;
	onRebuild?: (call: number) => Promise<void>;
}

interface ResetHarness {
	agent: Agent;
	gate: RebuildGate;
	providerSystemPrompts: string[][];
	session: AgentSession;
	sessionManager: SessionManager;
}

const sessions: AgentSession[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (sessions.length > 0) {
		await sessions.pop()?.dispose();
	}
});

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "reset-context-test",
		name: "reset-context-test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createResetHarness(): ResetHarness {
	const gate: RebuildGate = { calls: 0 };
	const providerSystemPrompts: string[][] = [];
	const mock = createMockModel({ responses: [{ content: ["Done"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: createModel(),
			systemPrompt: [STALE_FIRST_TURN_GUIDANCE],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: (model, context, options) => {
			providerSystemPrompts.push([...(context.systemPrompt ?? [])]);
			return mock.stream(model, context, options);
		},
	});
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		rebuildSystemPrompt: async () => {
			gate.calls++;
			await gate.onRebuild?.(gate.calls);
			if (gate.error) throw gate.error;
			return { systemPrompt: [REBUILT_SYSTEM_PROMPT] };
		},
	});
	sessions.push(session);
	return { agent, gate, providerSystemPrompts, session, sessionManager };
}

function appendPriorTurn(harness: ResetHarness): void {
	const priorMessage = { role: "user" as const, content: "prior turn", timestamp: Date.now() };
	harness.agent.appendMessage(priorMessage);
	harness.sessionManager.appendMessage(priorMessage);
}

function createControllerHarness(session: AgentSession) {
	const clearTransientSessionUi = vi.fn();
	const present = vi.fn();
	const requestRender = vi.fn();
	const resetTranscript = vi.fn();
	const showError = vi.fn();
	const showWarning = vi.fn();
	const statusInvalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const ctx = {
		session,
		clearTransientSessionUi,
		present,
		resetTranscript,
		showError,
		showWarning,
		statusLine: { invalidate: statusInvalidate },
		ui: { requestRender },
		updateEditorBorderColor,
	} as unknown as InteractiveModeContext;
	return {
		clearTransientSessionUi,
		controller: new CommandController(ctx),
		present,
		requestRender,
		resetTranscript,
		showError,
		showWarning,
		statusInvalidate,
		updateEditorBorderColor,
	};
}

describe("AgentSession committed context reset failures", () => {
	it("rejects direct callers with committed state and refreshes before the next provider turn", async () => {
		const harness = createResetHarness();
		appendPriorTurn(harness);
		const refreshFailure = new Error("prompt refresh failed");
		harness.gate.error = refreshFailure;

		let resetError: unknown;
		try {
			await harness.session.resetSessionContext();
		} catch (error) {
			resetError = error;
		}

		expect(resetError).toBeInstanceOf(CommittedResetSessionContextError);
		expect((resetError as CommittedResetSessionContextError).cause).toBe(refreshFailure);
		expect((resetError as CommittedResetSessionContextError).result).toEqual({ droppedCount: 1 });
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.buildSessionContext()).toMatchObject({ messages: [] });
		expect(harness.sessionManager.getBranch().at(-1)?.type).toBe("reset_boundary");

		harness.gate.error = undefined;
		await harness.session.prompt("next turn");
		await harness.session.waitForIdle();

		expect(harness.gate.calls).toBe(2);
		expect(harness.providerSystemPrompts).toEqual([[REBUILT_SYSTEM_PROMPT]]);
	});

	it("keeps a reset refresh pending when an older refresh completes after the reset commits", async () => {
		const harness = createResetHarness();
		appendPriorTurn(harness);
		const staleRefreshStarted = Promise.withResolvers<void>();
		const releaseStaleRefresh = Promise.withResolvers<void>();
		const resetMemoryStarted = Promise.withResolvers<void>();
		const releaseResetMemory = Promise.withResolvers<void>();
		harness.gate.onRebuild = async call => {
			if (call !== 1) return;
			staleRefreshStarted.resolve();
			await releaseStaleRefresh.promise;
		};
		vi.spyOn(SessionMemory.prototype, "resetContextForNewTranscript").mockImplementation(async () => {
			resetMemoryStarted.resolve();
			await releaseResetMemory.promise;
		});

		const staleRefresh = harness.session.refreshBaseSystemPrompt();
		await staleRefreshStarted.promise;
		const reset = harness.session.resetSessionContext();
		await resetMemoryStarted.promise;
		releaseStaleRefresh.resolve();
		await staleRefresh;
		releaseResetMemory.resolve();
		await reset;

		expect(harness.gate.calls).toBe(2);
	});

	it("refreshes exactly once before an agent-initiated provider turn", async () => {
		const harness = createResetHarness();
		appendPriorTurn(harness);
		harness.gate.error = new Error("prompt refresh failed");
		await expect(harness.session.resetSessionContext()).rejects.toBeInstanceOf(CommittedResetSessionContextError);
		harness.gate.error = undefined;

		await harness.session.sendCustomMessage(
			{
				customType: "reset-follow-up",
				content: "agent initiated follow-up",
				display: false,
				attribution: "agent",
			},
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();

		expect(harness.gate.calls).toBe(2);
		expect(harness.providerSystemPrompts).toEqual([[REBUILT_SYSTEM_PROMPT]]);
	});

	it("finishes interactive transcript and status teardown before showing a committed refresh error", async () => {
		const harness = createResetHarness();
		appendPriorTurn(harness);
		harness.gate.error = new Error("prompt refresh failed");
		const ui = createControllerHarness(harness.session);

		await expect(ui.controller.handleResetContextCommand()).resolves.toBeUndefined();

		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.buildSessionContext()).toMatchObject({ messages: [] });
		expect(ui.clearTransientSessionUi).toHaveBeenCalledTimes(1);
		expect(ui.resetTranscript).toHaveBeenCalledTimes(1);
		expect(ui.statusInvalidate).toHaveBeenCalledTimes(1);
		expect(ui.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(ui.present).not.toHaveBeenCalled();
		expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining("prompt refresh failed"));
		expect(ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("tears down interactive UI when reset boundary persistence fails after context clearing", async () => {
		const harness = createResetHarness();
		appendPriorTurn(harness);
		const boundaryFailure = new Error("reset boundary persistence failed");
		vi.spyOn(harness.sessionManager, "appendResetBoundary").mockImplementationOnce(() => {
			throw boundaryFailure;
		});
		const ui = createControllerHarness(harness.session);

		await expect(ui.controller.handleResetContextCommand()).resolves.toBeUndefined();

		expect(harness.session.messages).toEqual([]);
		expect(ui.clearTransientSessionUi).toHaveBeenCalledTimes(1);
		expect(ui.resetTranscript).toHaveBeenCalledTimes(1);
		expect(ui.statusInvalidate).toHaveBeenCalledTimes(1);
		expect(ui.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(ui.present).not.toHaveBeenCalled();
		expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining(boundaryFailure.message));
		expect(ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("keeps the existing context and UI when reset fails before commit", async () => {
		const harness = createResetHarness();
		appendPriorTurn(harness);
		const ui = createControllerHarness(harness.session);
		const precommitFailure = new Error("reset precommit failed");
		vi.spyOn(harness.agent, "reset").mockImplementationOnce(() => {
			throw precommitFailure;
		});

		await expect(ui.controller.handleResetContextCommand()).rejects.toBe(precommitFailure);

		expect(harness.session.messages).toHaveLength(1);
		expect(harness.sessionManager.buildSessionContext().messages).toHaveLength(1);
		expect(ui.clearTransientSessionUi).not.toHaveBeenCalled();
		expect(ui.resetTranscript).not.toHaveBeenCalled();
		expect(ui.statusInvalidate).not.toHaveBeenCalled();
		expect(ui.updateEditorBorderColor).not.toHaveBeenCalled();
		expect(ui.present).not.toHaveBeenCalled();
		expect(ui.showError).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
	});
});
