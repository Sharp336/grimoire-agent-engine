import { describe, expect, it, vi } from "bun:test";
import {
	CouncilCoordinator,
	getCouncilCoordinator,
	resetCouncilCoordinatorsForTests,
} from "@oh-my-pi/pi-coding-agent/council/coordinator";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleMoveCommand = vi.fn(async () => {});
	const showError = vi.fn();
	const setText = vi.fn();
	const addToHistory = vi.fn();
	const sessionManager = {
		getCwd: () => "/tmp/project",
		getSessionId: () => "move-command-test",
	};
	const toolSession = {};
	const session = {
		getToolSession: () => toolSession,
		modelRegistry: {},
	};
	return {
		handleMoveCommand,
		showError,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				session,
				sessionManager,
				settings: {},
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				showError,
				handleMoveCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/move slash command", () => {
	it("routes the path through the move handler and saves the full command to history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/move /tmp/project", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleMoveCommand).toHaveBeenCalledWith("/tmp/project");
	});

	it("routes a blank /move invocation to the interactive move handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/move   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleMoveCommand).toHaveBeenCalledWith(undefined);
	});

	it("rejects relocation during deferred council preflight without cancelling the setup", async () => {
		const cancelSpy = vi.spyOn(CouncilCoordinator.prototype, "cancelForSessionTransition");
		try {
			const harness = createRuntime();
			const ctx = harness.runtime.ctx;
			const coordinator = getCouncilCoordinator({
				session: ctx.session,
				toolSession: ctx.session.getToolSession(),
				sessionManager: ctx.sessionManager,
				settings: ctx.settings,
				modelRegistry: ctx.session.modelRegistry,
			});
			Object.defineProperty(coordinator, "setupInFlight", { configurable: true, value: true });

			const handled = await executeBuiltinSlashCommand("/move /tmp/other", harness.runtime);

			expect(handled).toBe(true);
			expect(harness.showError).toHaveBeenCalledWith(
				"Cannot move while council setup/preflight is in progress; use /council cancel first.",
			);
			expect(harness.handleMoveCommand).not.toHaveBeenCalled();
			expect(cancelSpy).not.toHaveBeenCalled();
		} finally {
			cancelSpy.mockRestore();
			resetCouncilCoordinatorsForTests();
		}
	});
});
