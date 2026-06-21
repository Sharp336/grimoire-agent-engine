import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createContext() {
	let editorText = "";
	const handleQueueCommand = vi.fn(async (_message: string) => {});
	const showError = vi.fn();
	const ctx = {
		editor: {
			setText(text: string) {
				editorText = text;
			},
			getText() {
				return editorText;
			},
		},
		showError,
		handleQueueCommand,
	} as unknown as InteractiveModeContext;

	return { ctx, handleQueueCommand, showError };
}

describe("/queue slash command", () => {
	it("delegates arguments to the TUI queue handler", async () => {
		const { ctx, handleQueueCommand } = createContext();
		ctx.editor.setText("/queue finish this after the turn");

		const result = await executeBuiltinSlashCommand("/queue finish this after the turn", { ctx });

		expect(result).toBe(true);
		expect(handleQueueCommand).toHaveBeenCalledWith("finish this after the turn");
		expect(ctx.editor.getText()).toBe("");
	});

	it("shows usage when no message is provided", async () => {
		const { ctx, handleQueueCommand, showError } = createContext();
		ctx.editor.setText("/queue");

		const result = await executeBuiltinSlashCommand("/queue", { ctx });

		expect(result).toBe(true);
		expect(showError).toHaveBeenCalledWith("Usage: /queue <message>");
		expect(handleQueueCommand).not.toHaveBeenCalled();
		expect(ctx.editor.getText()).toBe("");
	});
});
