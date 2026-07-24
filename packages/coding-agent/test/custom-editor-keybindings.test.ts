import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
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

	it("routes the default legacy-safe consultation chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onConsult = vi.fn();

		editor.onConsult = onConsult;
		editor.handleInput("\x1bQ");

		expect(onConsult).toHaveBeenCalledTimes(1);
	});

	it("routes a configured consultation override through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onConsult = vi.fn();

		editor.setActionKeys("app.consult", ["alt+shift+c"]);
		editor.onConsult = onConsult;
		editor.handleInput("\x1bC");

		expect(onConsult).toHaveBeenCalledTimes(1);
	});

	it("keeps raw Ctrl+C clear when consultation is user-remapped to Ctrl+Shift+C", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onClear = vi.fn();
		const onConsult = vi.fn();

		editor.setActionKeys("app.clear", ["ctrl+c"]);
		editor.setActionKeys("app.consult", ["ctrl+shift+c"]);
		editor.onClear = onClear;
		editor.onConsult = onConsult;

		editor.handleInput("\x03");

		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onConsult).not.toHaveBeenCalled();

		// Kitty CSI-u encodes Shift (1) + Ctrl (4) as the 1-indexed modifier value 6.
		editor.handleInput("\x1b[99;6u");

		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onConsult).toHaveBeenCalledTimes(1);
	});

	it("keeps printable bracket keys as editor input when consultation is configured", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onConsult = vi.fn();

		editor.setActionKeys("app.consult", ["alt+shift+c"]);
		editor.onConsult = onConsult;
		editor.handleInput("[");
		editor.handleInput("]");

		expect(editor.getText()).toBe("[]");
		expect(onConsult).not.toHaveBeenCalled();
	});
});
