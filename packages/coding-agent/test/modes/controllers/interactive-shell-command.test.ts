import { afterEach, describe, expect, it, vi } from "bun:test";
import * as interactiveShell from "@oh-my-pi/pi-coding-agent/exec/interactive-shell";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(options: { isStreaming?: boolean; isBashRunning?: boolean; isEvalRunning?: boolean } = {}) {
	const order: string[] = [];
	const moveTo = vi.fn(async () => {});
	const applyCwdChange = vi.fn(async () => {});
	const reloadTodos = vi.fn(async () => {});
	const stop = vi.fn(() => {
		order.push("stop");
	});
	const start = vi.fn(() => {
		order.push("start");
	});
	const ctx = {
		ui: { stop, start, requestRender: vi.fn() },
		settings: {},
		session: {
			isStreaming: options.isStreaming ?? false,
			isBashRunning: options.isBashRunning ?? false,
			isEvalRunning: options.isEvalRunning ?? false,
		},
		sessionManager: {
			getCwd: () => "/repo/current",
			moveTo,
		},
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		reloadTodos,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, order, moveTo, applyCwdChange, reloadTodos, start, stop };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CommandController interactive shell", () => {
	it("hands terminal ownership to the shell and restores the TUI once after success", async () => {
		const { ctx, order, start, stop } = createContext();
		vi.spyOn(interactiveShell, "resolveInteractiveShellPath").mockReturnValue("/bin/zsh");
		vi.spyOn(interactiveShell, "runInteractiveShell").mockImplementation(async () => {
			order.push("run");
			return { exitCode: 0 };
		});

		await new CommandController(ctx).handleInteractiveShell();

		expect(order).toEqual(["stop", "run", "start"]);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith("Opening shell (zsh)...");
	});

	it("restores the TUI once and reports a spawn failure", async () => {
		const { ctx, start, stop } = createContext();
		vi.spyOn(interactiveShell, "resolveInteractiveShellPath").mockReturnValue("/bin/zsh");
		vi.spyOn(interactiveShell, "runInteractiveShell").mockRejectedValue(new Error("spawn denied"));

		await new CommandController(ctx).handleInteractiveShell();

		expect(stop).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(1);
		expect(ctx.showError).toHaveBeenCalledWith("Failed to open shell (zsh): spawn denied");
	});

	it("restores the TUI once when stopping it throws after partial teardown", async () => {
		const { ctx, order, start, stop } = createContext();
		vi.spyOn(interactiveShell, "resolveInteractiveShellPath").mockReturnValue("/bin/zsh");
		const run = vi.spyOn(interactiveShell, "runInteractiveShell");
		stop.mockImplementation(() => {
			order.push("stop");
			throw new Error("stop failed");
		});

		await new CommandController(ctx).handleInteractiveShell();

		expect(order).toEqual(["stop", "start"]);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(1);
		expect(run).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalledWith("Failed to open shell (zsh): stop failed");
	});

	it("adopts the validated shell cwd through the existing cwd reload flow", async () => {
		const { ctx, moveTo, applyCwdChange, reloadTodos } = createContext();
		vi.spyOn(interactiveShell, "resolveInteractiveShellPath").mockReturnValue("/bin/zsh");
		vi.spyOn(interactiveShell, "runInteractiveShell").mockResolvedValue({
			exitCode: 0,
			workingDir: "/repo/next",
		});

		await new CommandController(ctx).handleInteractiveShell();

		expect(moveTo).toHaveBeenCalledWith("/repo/next");
		expect(applyCwdChange).toHaveBeenCalledWith("/repo/next");
		expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(reloadTodos).toHaveBeenCalledTimes(1);
	});

	it("does not transfer terminal ownership while session work is active", async () => {
		const { ctx, start, stop } = createContext({ isBashRunning: true });
		vi.spyOn(interactiveShell, "resolveInteractiveShellPath").mockReturnValue("/bin/zsh");
		const run = vi.spyOn(interactiveShell, "runInteractiveShell");

		await new CommandController(ctx).handleInteractiveShell();

		expect(run).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(ctx.showWarning).toHaveBeenCalledWith(
			"Wait for active work to finish or abort it before opening a shell.",
		);
	});
});
