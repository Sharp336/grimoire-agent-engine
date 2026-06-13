import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode workflowz mode", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-workflowz-mode-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("toggles both the UI flag and the session injection flag on and off", async () => {
		expect(mode.workflowzModeEnabled).toBe(false);
		expect(session.getWorkflowzModeEnabled()).toBe(false);

		await mode.handleWorkflowzModeCommand();
		expect(mode.workflowzModeEnabled).toBe(true);
		expect(session.getWorkflowzModeEnabled()).toBe(true);

		await mode.handleWorkflowzModeCommand();
		expect(mode.workflowzModeEnabled).toBe(false);
		expect(session.getWorkflowzModeEnabled()).toBe(false);
	});

	it("resets the mode through the /new command path", async () => {
		await mode.handleWorkflowzModeCommand();
		expect(mode.workflowzModeEnabled).toBe(true);

		await mode.handleClearCommand();
		expect(mode.workflowzModeEnabled).toBe(false);
		expect(session.getWorkflowzModeEnabled()).toBe(false);
	});

	it("resets the mode through the /drop command path", async () => {
		await mode.handleWorkflowzModeCommand();
		expect(mode.workflowzModeEnabled).toBe(true);

		await mode.handleDropCommand();
		expect(mode.workflowzModeEnabled).toBe(false);
		expect(session.getWorkflowzModeEnabled()).toBe(false);
	});

	it("persists through a non-session-reset transition (loop toggle)", async () => {
		await mode.handleWorkflowzModeCommand();
		expect(mode.workflowzModeEnabled).toBe(true);

		// Enabling an unrelated runtime mode must not clear workflowz: the reset is
		// scoped to session switches (/new, /drop), not arbitrary transitions.
		await mode.handleLoopCommand();
		expect(mode.workflowzModeEnabled).toBe(true);
		expect(session.getWorkflowzModeEnabled()).toBe(true);
	});

	it("repaints the border and feeds the badge an enabled status when toggled", async () => {
		const borderSpy = vi.spyOn(mode, "updateEditorTopBorder");
		const statusSpy = vi.spyOn(mode.statusLine, "setWorkflowzModeStatus");
		const enableBorderBefore = borderSpy.mock.calls.length;
		await mode.handleWorkflowzModeCommand();
		// Toggling on must both repaint the border and feed the badge an enabled status;
		// asserting only the repaint would pass even if the badge data were never set.
		expect(borderSpy.mock.calls.length).toBeGreaterThan(enableBorderBefore);
		expect(statusSpy).toHaveBeenLastCalledWith({ enabled: true });
		const disableBorderBefore = borderSpy.mock.calls.length;
		await mode.handleWorkflowzModeCommand();
		expect(borderSpy.mock.calls.length).toBeGreaterThan(disableBorderBefore);
		expect(statusSpy).toHaveBeenLastCalledWith(undefined);
	});
});
