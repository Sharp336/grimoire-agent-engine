import { afterEach, describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(
	initialOrchestratorMode = false,
	overrides?: {
		setOrchestratorMode?: (enabled: boolean) => Promise<void>;
	},
) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const invalidate = vi.fn();
	const updateEditorTopBorder = vi.fn();
	const requestRender = vi.fn();
	let orchestratorMode = initialOrchestratorMode;
	const setOrchestratorMode = vi.fn(async (enabled: boolean) => {
		if (overrides?.setOrchestratorMode) {
			await overrides.setOrchestratorMode(enabled);
			return;
		}
		orchestratorMode = enabled;
	});
	const toggleOrchestratorMode = vi.fn(async () => {
		const enabled = !orchestratorMode;
		await setOrchestratorMode(enabled);
		return enabled;
	});
	const handleOrchestratorToggle = vi.fn(async () => {
		const shouldEnable = !orchestratorMode;
		try {
			const enabled = await toggleOrchestratorMode();
			invalidate();
			updateEditorTopBorder();
			requestRender();
			showStatus(`Orchestrator mode ${enabled ? "enabled" : "disabled"}.`);
		} catch (error) {
			if (!shouldEnable) throw error;
			showStatus(`Orchestrator mode failed to enable: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		session: {
			get orchestratorMode() {
				return orchestratorMode;
			},
			setOrchestratorMode,
			toggleOrchestratorMode,
		} as unknown as InteractiveModeContext["session"],
		statusLine: { invalidate } as unknown as InteractiveModeContext["statusLine"],
		updateEditorTopBorder,
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		showStatus,
		handleOrchestratorToggle,
	} as unknown as InteractiveModeContext;

	return {
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
		setText,
		showStatus,
		invalidate,
		updateEditorTopBorder,
		requestRender,
		setOrchestratorMode,
		toggleOrchestratorMode,
		handleOrchestratorToggle,
		getOrchestratorMode: () => orchestratorMode,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/orchestrator slash command", () => {
	it("toggles when run without args", async () => {
		const harness = createRuntimeHarness(false);

		const handled = await executeBuiltinSlashCommand("/orchestrator", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(true);
		expect(harness.handleOrchestratorToggle).toHaveBeenCalledTimes(1);
		expect(harness.toggleOrchestratorMode).toHaveBeenCalledTimes(1);
		expect(harness.setOrchestratorMode).toHaveBeenCalledWith(true);
		expect(harness.invalidate).toHaveBeenCalledTimes(1);
		expect(harness.updateEditorTopBorder).toHaveBeenCalledTimes(1);
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("Orchestrator mode enabled.");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("treats toggle subcommand the same as bare command", async () => {
		const harness = createRuntimeHarness(true);

		const handled = await executeBuiltinSlashCommand("/orchestrator toggle", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(false);
		expect(harness.handleOrchestratorToggle).toHaveBeenCalledTimes(1);
		expect(harness.toggleOrchestratorMode).toHaveBeenCalledTimes(1);
		expect(harness.setOrchestratorMode).toHaveBeenCalledWith(false);
		expect(harness.showStatus).toHaveBeenCalledWith("Orchestrator mode disabled.");
	});

	it("surfaces orchestrator enable failure for bare command", async () => {
		const harness = createRuntimeHarness(false, {
			setOrchestratorMode: async enabled => {
				if (enabled) {
					throw new Error("git repository not found");
				}
			},
		});

		const handled = await executeBuiltinSlashCommand("/orchestrator", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(false);
		expect(harness.handleOrchestratorToggle).toHaveBeenCalledTimes(1);
		expect(harness.invalidate).not.toHaveBeenCalled();
		expect(harness.updateEditorTopBorder).not.toHaveBeenCalled();
		expect(harness.requestRender).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Orchestrator mode failed to enable: git repository not found");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("enables orchestrator mode explicitly", async () => {
		const harness = createRuntimeHarness(false);

		const handled = await executeBuiltinSlashCommand("/orchestrator on", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(true);
		expect(harness.handleOrchestratorToggle).not.toHaveBeenCalled();
		expect(harness.setOrchestratorMode).toHaveBeenCalledWith(true);
		expect(harness.toggleOrchestratorMode).not.toHaveBeenCalled();
		expect(harness.invalidate).toHaveBeenCalledTimes(1);
		expect(harness.updateEditorTopBorder).toHaveBeenCalledTimes(1);
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("Orchestrator mode enabled.");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("surfaces explicit orchestrator enable failure", async () => {
		const harness = createRuntimeHarness(false, {
			setOrchestratorMode: async enabled => {
				if (enabled) {
					throw new Error("git repository not found");
				}
			},
		});

		const handled = await executeBuiltinSlashCommand("/orchestrator on", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(false);
		expect(harness.handleOrchestratorToggle).not.toHaveBeenCalled();
		expect(harness.setOrchestratorMode).toHaveBeenCalledWith(true);
		expect(harness.toggleOrchestratorMode).not.toHaveBeenCalled();
		expect(harness.invalidate).not.toHaveBeenCalled();
		expect(harness.updateEditorTopBorder).not.toHaveBeenCalled();
		expect(harness.requestRender).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Orchestrator mode failed to enable: git repository not found");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("disables orchestrator mode explicitly", async () => {
		const harness = createRuntimeHarness(true);

		const handled = await executeBuiltinSlashCommand("/orchestrator off", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(false);
		expect(harness.handleOrchestratorToggle).not.toHaveBeenCalled();
		expect(harness.setOrchestratorMode).toHaveBeenCalledWith(false);
		expect(harness.toggleOrchestratorMode).not.toHaveBeenCalled();
		expect(harness.invalidate).toHaveBeenCalledTimes(1);
		expect(harness.updateEditorTopBorder).toHaveBeenCalledTimes(1);
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("Orchestrator mode disabled.");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("reports status without mutating session", async () => {
		const harness = createRuntimeHarness(true);

		const handled = await executeBuiltinSlashCommand("/orchestrator status", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(true);
		expect(harness.handleOrchestratorToggle).not.toHaveBeenCalled();
		expect(harness.setOrchestratorMode).not.toHaveBeenCalled();
		expect(harness.toggleOrchestratorMode).not.toHaveBeenCalled();
		expect(harness.invalidate).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Orchestrator mode is on.");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows usage for invalid args without mutating session", async () => {
		const harness = createRuntimeHarness(false);

		const handled = await executeBuiltinSlashCommand("/orchestrator nope", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getOrchestratorMode()).toBe(false);
		expect(harness.handleOrchestratorToggle).not.toHaveBeenCalled();
		expect(harness.setOrchestratorMode).not.toHaveBeenCalled();
		expect(harness.toggleOrchestratorMode).not.toHaveBeenCalled();
		expect(harness.invalidate).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /orchestrator [on|off|status]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
