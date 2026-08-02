import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleSideCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleSideCommand,
		setText,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as Partial<
					InteractiveModeContext["editor"]
				> as InteractiveModeContext["editor"],
				handleSideCommand,
			} as Partial<InteractiveModeContext> as InteractiveModeContext,
		},
	};
}

describe("/side slash command", () => {
	it("routes the question through the side handler and clears the editor", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/side which deps are unused", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleSideCommand).toHaveBeenCalledWith("which deps are unused");
	});

	it("reaches the create-and-focus path with no question on a blank invocation", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/side   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleSideCommand).toHaveBeenCalledWith("");
	});

	it("passes the end subcommand through the allowArgs gate as an argument", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/side end", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleSideCommand).toHaveBeenCalledWith("end");
	});
});
