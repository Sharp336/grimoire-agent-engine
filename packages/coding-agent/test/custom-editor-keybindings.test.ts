import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getKeybindings, setKeybindings, setSuperMirrorsCtrl } from "@oh-my-pi/pi-tui";

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		setSuperMirrorsCtrl(process.platform === "darwin");
	});

	it("yields Command+O to a TUI binding the central manager already reserved", () => {
		const previous = getKeybindings();
		setSuperMirrorsCtrl(true);
		// The manager reserves super+o for undo, so the mirror of the editor's
		// ctrl+o must not reclaim it — handleInput would otherwise intercept the
		// chord before super.handleInput() ever reaches the base editor.
		setKeybindings(KeybindingsManager.inMemory({ "tui.editor.undo": "super+o" }));
		try {
			const editor = new CustomEditor(getEditorTheme());
			const onExpandTools = vi.fn();
			editor.onExpandTools = onExpandTools;
			editor.setActionKeys("app.tools.expand", ["ctrl+o"]);
			editor.handleInput("\x1b[111;9u");

			expect(onExpandTools).not.toHaveBeenCalled();
			editor.handleInput("\x0f");
			expect(onExpandTools).toHaveBeenCalledTimes(1);
		} finally {
			setKeybindings(previous);
		}
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("lets an extension's explicit Command chord outrank a mirrored built-in", () => {
		// The mirror must be live before the editor builds its match sets.
		setSuperMirrorsCtrl(true);
		const editor = new CustomEditor(getEditorTheme());
		const onExpandTools = vi.fn();
		const extension = vi.fn();

		editor.onExpandTools = onExpandTools;
		editor.setActionKeys("app.tools.expand", ["ctrl+o"]);
		// Without precedence the mirror of ctrl+o also claims super+o, and
		// handleInput checks the built-in action before custom handlers.
		editor.setCustomKeyHandler("super+o", extension);
		editor.handleInput("\x1b[111;9u");

		expect(extension).toHaveBeenCalledTimes(1);
		expect(onExpandTools).not.toHaveBeenCalled();
		// The built-in keeps its own real chord.
		editor.handleInput("\x0f");
		expect(onExpandTools).toHaveBeenCalledTimes(1);
	});

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("alt+r", customHandler);
		editor.handleInput("\x1br");

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["alt+r"]);
		editor.handleInput("\x1br");

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});
});
