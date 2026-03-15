import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/move slash command", () => {
	it("strips surrounding double quotes before forwarding the path", async () => {
		const handleMoveCommand = vi.fn(async () => {});
		const runtime = {
			ctx: {
				editor: { setText: () => {} },
				handleMoveCommand,
				showError: () => {},
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		};

		const handled = await executeBuiltinSlashCommand('/move "C:/Users/test user/project"', runtime);

		expect(handled).toBe(true);
		expect(handleMoveCommand).toHaveBeenCalledWith("C:/Users/test user/project");
	});

	it("strips surrounding single quotes before forwarding the path", async () => {
		const handleMoveCommand = vi.fn(async () => {});
		const runtime = {
			ctx: {
				editor: { setText: () => {} },
				handleMoveCommand,
				showError: () => {},
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		};

		const handled = await executeBuiltinSlashCommand("/move '/tmp/path with spaces'", runtime);

		expect(handled).toBe(true);
		expect(handleMoveCommand).toHaveBeenCalledWith("/tmp/path with spaces");
	});
});
