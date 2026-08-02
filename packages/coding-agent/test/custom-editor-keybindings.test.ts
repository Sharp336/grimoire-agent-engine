import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
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

	it("routes Ctrl+L to a live-toggle custom handler and Alt+L to display reset by default", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onDisplayReset = vi.fn();
		const onLiveToggle = vi.fn();

		editor.onDisplayReset = onDisplayReset;
		editor.setCustomKeyHandler("ctrl+l", onLiveToggle);

		editor.handleInput("\x0c"); // Ctrl+L
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
		expect(onDisplayReset).not.toHaveBeenCalled();

		editor.handleInput("\x1bl"); // Alt+L
		expect(onDisplayReset).toHaveBeenCalledTimes(1);
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
	});

	it("accepts a Tab suggestion on an empty editor and consumes it once", () => {
		const editor = new CustomEditor(getEditorTheme());

		editor.setTabSuggestion("git status");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("git status");

		// Second Tab is plain input now that the suggestion was consumed.
		editor.setText("");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("");
	});

	it("drops a Tab suggestion on any other keystroke instead of letting it resurface", () => {
		const editor = new CustomEditor(getEditorTheme());

		editor.setTabSuggestion("git status");
		editor.handleInput("x");
		editor.setText("");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("");
	});

	it("never claims Tab for a suggestion once the editor has text", () => {
		const editor = new CustomEditor(getEditorTheme());

		editor.setText("already typing");
		editor.setTabSuggestion("git status");
		editor.handleInput("\t");

		expect(editor.getText()).not.toBe("git status");
	});

	it('notifies onOutcome with "accepted" exactly once when Tab consumes the suggestion', () => {
		const editor = new CustomEditor(getEditorTheme());
		const onOutcome = vi.fn();

		editor.setTabSuggestion("git status", onOutcome);
		editor.handleInput("\t");

		expect(onOutcome).toHaveBeenCalledTimes(1);
		expect(onOutcome).toHaveBeenCalledWith("accepted");
	});

	it('notifies onOutcome with "dismissed" when another keystroke drops the suggestion', () => {
		const editor = new CustomEditor(getEditorTheme());
		const onOutcome = vi.fn();

		editor.setTabSuggestion("git status", onOutcome);
		editor.handleInput("x");

		expect(onOutcome).toHaveBeenCalledTimes(1);
		expect(onOutcome).toHaveBeenCalledWith("dismissed");
	});

	it('notifies onOutcome with "dismissed" when a new suggestion supersedes an unresolved one', () => {
		const editor = new CustomEditor(getEditorTheme());
		const first = vi.fn();
		const second = vi.fn();

		editor.setTabSuggestion("git status", first);
		editor.setTabSuggestion("git log", second);

		expect(first).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledWith("dismissed");
		expect(second).not.toHaveBeenCalled();

		editor.handleInput("\t");
		expect(editor.getText()).toBe("git log");
		expect(second).toHaveBeenCalledWith("accepted");
	});

	it('notifies onOutcome with "dismissed" when the caller clears the suggestion early', () => {
		const editor = new CustomEditor(getEditorTheme());
		const onOutcome = vi.fn();

		editor.setTabSuggestion("git status", onOutcome);
		editor.setTabSuggestion(undefined);

		expect(onOutcome).toHaveBeenCalledTimes(1);
		expect(onOutcome).toHaveBeenCalledWith("dismissed");
	});

	it("never fires onOutcome when nothing was pending", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onOutcome = vi.fn();

		editor.setTabSuggestion(undefined, onOutcome);
		editor.handleInput("x");

		expect(onOutcome).not.toHaveBeenCalled();
	});
});

describe("shipped dequeue defaults", () => {
	it("binds both alt+up and shift+up to the steering dequeue", () => {
		const keybindings = KeybindingsManager.inMemory();
		const keys = keybindings.getKeys("app.message.dequeue");
		expect(keys).toContain("alt+up");
		expect(keys).toContain("shift+up");
	});
	it("does not steal shift+up from an explicit user binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.editor.cursorUp": "shift+up",
		});

		expect(keybindings.getKeys("app.message.dequeue")).toEqual(["alt+up"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["shift+up"]);
	});
	it("routes the shipped shift+up default through DEFAULT_ACTION_KEYS to the dequeue handler", () => {
		// F12: the registry test above does not cover DEFAULT_ACTION_KEYS, the second
		// defaults table that custom-editor.ts seeds its match set from. Drive a real
		// editor without calling setActionKeys, so the shipped entry is the only thing
		// that can make the shift+up wire form (CSI 1;2A) reach onDequeue.
		const editor = new CustomEditor(getEditorTheme());
		const onDequeue = vi.fn();

		editor.onDequeue = onDequeue;
		editor.handleInput("\x1b[1;2A");

		expect(onDequeue).toHaveBeenCalledTimes(1);
	});
});
