import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as updateCli from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(sessionState: Partial<InteractiveModeContext["session"]> = {}) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const restartCurrentSession = vi.fn(async () => {});
	return {
		setText,
		showStatus,
		showWarning,
		showError,
		present,
		restartCurrentSession,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				session: {
					isStreaming: false,
					isCompacting: false,
					isBashRunning: false,
					isEvalRunning: false,
					...sessionState,
				} as unknown as InteractiveModeContext["session"],
				showStatus,
				showWarning,
				showError,
				present,
				restartCurrentSession,
			} as unknown as InteractiveModeContext,
		},
	};
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/update slash command", () => {
	it("checks for updates without restarting", async () => {
		const harness = createRuntimeHarness();
		const runUpdateFlow = vi.spyOn(updateCli, "runUpdateFlow").mockResolvedValue({
			kind: "update-available",
			currentVersion: "15.13.0",
			latestVersion: "15.13.2",
			checkOnly: true,
		});

		expect(await executeBuiltinSlashCommand("/update --check", harness.runtime)).toBe(true);

		expect(runUpdateFlow).toHaveBeenCalledWith(
			{ force: false, check: true, showChangelog: false },
			expect.objectContaining({ log: expect.any(Function), error: expect.any(Function) }),
		);
		expect(harness.restartCurrentSession).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("restarts after a successful update", async () => {
		const harness = createRuntimeHarness();
		vi.spyOn(updateCli, "runUpdateFlow").mockResolvedValue({
			kind: "updated",
			previousVersion: "15.13.0",
			version: "15.13.2",
			forced: false,
			changelogPrinted: false,
		});

		expect(await executeBuiltinSlashCommand("/update", harness.runtime)).toBe(true);

		expect(updateCli.runUpdateFlow).toHaveBeenCalledWith(
			{ force: false, check: false, showChangelog: true },
			expect.objectContaining({ log: expect.any(Function), error: expect.any(Function) }),
		);

		expect(harness.showStatus).toHaveBeenCalledWith("Restarting OMP to use v15.13.2...");
		expect(harness.restartCurrentSession).toHaveBeenCalledWith({ showChangelog: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("falls back to resumed changelog when update result says notes printed but none were captured", async () => {
		const harness = createRuntimeHarness();
		vi.spyOn(updateCli, "runUpdateFlow").mockResolvedValue({
			kind: "updated",
			previousVersion: "15.13.0",
			version: "15.13.2",
			forced: false,
			changelogPrinted: true,
		});

		expect(await executeBuiltinSlashCommand("/update", harness.runtime)).toBe(true);

		expect(harness.restartCurrentSession).toHaveBeenCalledWith({ showChangelog: true, changelogMarkdown: undefined });
	});

	it("presents release notes without coalescing them into status", async () => {
		const harness = createRuntimeHarness();
		vi.spyOn(updateCli, "runUpdateFlow").mockImplementation(async (_options, output) => {
			await output.log("Current version: 15.13.0");
			await output.log("\nWhat's new:\n\n## [15.13.2]\n\n- Update UX");
			return {
				kind: "updated",
				previousVersion: "15.13.0",
				version: "15.13.2",
				forced: false,
				changelogPrinted: true,
			};
		});

		expect(await executeBuiltinSlashCommand("/update", harness.runtime)).toBe(true);

		expect(harness.showStatus).toHaveBeenCalledWith("Current version: 15.13.0");
		expect(harness.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("What's new:"));
		expect(harness.present).toHaveBeenCalledTimes(1);
		expect(harness.restartCurrentSession).toHaveBeenCalledWith({
			showChangelog: false,
			changelogMarkdown: "## [15.13.2]\n\n- Update UX",
		});
	});

	it("rejects unknown update flags without running the update flow", async () => {
		const harness = createRuntimeHarness();
		const runUpdateFlow = vi.spyOn(updateCli, "runUpdateFlow").mockResolvedValue({
			kind: "no-update",
			currentVersion: "15.13.2",
			latestVersion: "15.13.2",
		});

		expect(await executeBuiltinSlashCommand("/update --bogus", harness.runtime)).toBe(true);

		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /update [--check] [--force]");
		expect(runUpdateFlow).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("refuses install while work is running and keeps the typed command", async () => {
		const harness = createRuntimeHarness({ isStreaming: true } as Partial<InteractiveModeContext["session"]>);
		const runUpdateFlow = vi.spyOn(updateCli, "runUpdateFlow").mockResolvedValue({
			kind: "updated",
			previousVersion: "15.13.0",
			version: "15.13.2",
			forced: false,
			changelogPrinted: false,
		});

		expect(await executeBuiltinSlashCommand("/update", harness.runtime)).toBe(true);

		expect(harness.showStatus).toHaveBeenCalledWith("Wait for current work to finish before updating.");
		expect(runUpdateFlow).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
	});
});

describe("/restart slash command", () => {
	it("restarts the current session and clears the editor", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/restart", harness.runtime)).toBe(true);

		expect(harness.restartCurrentSession).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
