import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createMemoryContext(backend: string) {
	const showWarning = vi.fn();
	const ctx = {
		settings: Settings.isolated({ "memory.backend": backend }),
		sessionManager: { getCwd: () => "/tmp/project" },
		session: { waitForMemoryBackendReconcile: async () => {} },
		showWarning,
	} as unknown as InteractiveModeContext;
	return { ctx, showWarning };
}

describe("CommandController /memory", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory stats", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory stats");

		expect(showWarning).toHaveBeenCalledWith("Memory backend is off — there is nothing to show.");
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory diagnose", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory diagnose");

		expect(showWarning).toHaveBeenCalledWith("Memory backend is off — there is nothing to show.");
	});

	it("still names the backend when a real backend simply has no stats hook", async () => {
		const { ctx, showWarning } = createMemoryContext("local");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory stats");

		expect(showWarning).toHaveBeenCalledWith("Memory stats is not available for the local backend.");
	});

	it("reports unsupported OpenViking clear without detaching or refreshing the prompt", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const showError = vi.fn();
		const showStatus = vi.fn();
		const controller = new CommandController({
			settings,
			session: {
				waitForMemoryBackendReconcile: async () => {},
				refreshBaseSystemPrompt,
			},
			sessionManager: { getCwd: () => "/tmp/project" },
			showError,
			showStatus,
		} as unknown as InteractiveModeContext);

		await controller.handleMemoryCommand("/memory clear");

		expect(showError).toHaveBeenCalledWith(
			"Memory clear failed: OpenViking memory is server-side; /memory clear is not supported. Delete specific memory resources in OpenViking instead.",
		);
		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});
});
