/**
 * Regression test for: plan-model switch fires after plan-mode exit
 *
 * Bug: When plan mode is entered while the agent is streaming (session.isStreaming === true),
 * #applyPlanModeModel queues a pending model switch (this.#pendingModelSwitch) instead of
 * applying it immediately. When the user later exits plan mode via #exitPlanMode, the
 * existing code cleared #planModePreviousModelState but NOT #pendingModelSwitch. A
 * subsequent flushPendingModelSwitch() call (triggered by agent_end event in event-controller)
 * would then apply the plan-model switch, stranding the session on the plan model post-exit.
 *
 * Fix: #exitPlanMode now clears this.#pendingModelSwitch = undefined immediately after the
 * early-out guard, before restoring previous tools/model state.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("InteractiveMode: pending plan-model switch cleared on exit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		_resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-plan-exit-model-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		_resetSettingsForTest();
	});

	/**
	 * Construct a session with a default model and a distinct plan-role model.
	 * Returns the default model id so callers can assert the session stays on it post-exit.
	 */
	async function setupSessionAndMode(opts: {
		defaultModelId: string;
		planModelId: string;
	}): Promise<{ defaultModelId: string; planModelId: string }> {
		const modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", opts.defaultModelId);
		if (!defaultModel) throw new Error(`Model not found: ${opts.defaultModelId}`);

		const sessionSettings = Settings.isolated({
			modelRoles: {
				plan: `anthropic/${opts.planModelId}`,
			},
		});

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: defaultModel,
					systemPrompt: "Test",
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: sessionSettings,
			modelRegistry,
		});

		mode = new InteractiveMode(session, "test");
		return { defaultModelId: opts.defaultModelId, planModelId: opts.planModelId };
	}

	it("flushPendingModelSwitch is a no-op after exiting plan mode entered mid-stream", async () => {
		await setupSessionAndMode({
			defaultModelId: "claude-sonnet-4-5",
			planModelId: "claude-sonnet-4-6", // distinct plan model triggers the switch path
		});

		const defaultModelId = session.model?.id;

		// Patch sendPlanModeContext to avoid agent steering side effects during streaming
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);

		// Simulate isStreaming = true so #applyPlanModeModel queues #pendingModelSwitch
		// instead of calling setModelTemporary immediately.
		Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });

		// Enter plan mode while streaming — this queues #pendingModelSwitch (plan model)
		// without calling setModelTemporary yet (deferred).
		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(true);

		// Restore non-streaming state so #exitPlanMode's isStreaming check behaves normally.
		Object.defineProperty(session, "isStreaming", { get: () => false, configurable: true });

		// Patch showHookConfirm to auto-confirm the "Exit plan mode?" dialog.
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);

		// Spy on setModelTemporary to detect any unintended model switch.
		const setModelTemporarySpy = vi.spyOn(session, "setModelTemporary");

		// Exit plan mode. With the fix, #pendingModelSwitch is cleared here.
		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(false);

		// Now flush — this must be a no-op: the pending switch was cleared by #exitPlanMode.
		await mode.flushPendingModelSwitch();

		// The plan-model switch must NOT have been applied: session stays on the default model.
		expect(setModelTemporarySpy).not.toHaveBeenCalled();
		expect(session.model?.id).toBe(defaultModelId);
	});
});
