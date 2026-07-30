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

	it("lets Escape leave Vim insert mode before interrupting the app", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.setInputMode("vim");
		editor.onEscape = onEscape;

		editor.handleInput("i");
		editor.handleInput("\x1b");

		expect(editor.getVimMode()).toBe("normal");
		expect(onEscape).not.toHaveBeenCalled();

		editor.handleInput("\x1b");
		expect(onEscape).toHaveBeenCalledTimes(1);
	});
	it("lets Escape leave Vim visual mode before interrupting the app", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.setInputMode("vim");
		editor.setText("one\ntwo");
		editor.onEscape = onEscape;

		editor.handleInput("V");
		expect(editor.getVimMode()).toBe("visual");

		editor.handleInput("\x1b");
		expect(editor.getVimMode()).toBe("normal");
		expect(onEscape).not.toHaveBeenCalled();

		editor.handleInput("\x1b");
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("keeps Ctrl-R for Vim redo instead of opening history search", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onHistorySearch = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.history.search", ["ctrl+r"]);
		editor.onHistorySearch = onHistorySearch;

		editor.handleInput("i");
		for (const char of "hello") editor.handleInput(char);
		editor.handleInput("\x1b");
		editor.handleInput("u");
		expect(editor.getText()).toBe("");

		editor.handleInput("\x12");

		expect(editor.getText()).toBe("hello");
		expect(onHistorySearch).not.toHaveBeenCalled();

		editor.handleInput("v");
		editor.handleInput("\x12");
		expect(editor.getVimMode()).toBe("visual");
		expect(onHistorySearch).not.toHaveBeenCalled();

		editor.handleInput("\x1b");
		editor.handleInput("i");
		editor.handleInput("\x12");
		expect(editor.getVimMode()).toBe("insert");
		expect(onHistorySearch).toHaveBeenCalledTimes(1);
	});

	it("does not start push-to-talk from Vim normal-mode spaces", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onSpaceHoldStart = vi.fn();
		editor.setInputMode("vim");
		editor.onSpaceHoldStart = onSpaceHoldStart;
		editor.sttHoldEnabled = () => true;

		for (let i = 0; i < 10; i++) editor.handleInput(" ");

		expect(editor.getText()).toBe("");
		expect(onSpaceHoldStart).not.toHaveBeenCalled();
	});

	it("allows clipboard image paste only from Vim insert mode", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onPasteImage = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.clipboard.pasteImage", ["alt+p"]);
		editor.onPasteImage = onPasteImage;

		editor.handleInput("\x1bp");
		expect(onPasteImage).not.toHaveBeenCalled();

		editor.setText("text");
		editor.handleInput("v");
		expect(editor.getVimMode()).toBe("visual");
		editor.handleInput("\x1bp");
		expect(onPasteImage).not.toHaveBeenCalled();
		editor.handleInput("\x1b");

		editor.handleInput("i");
		editor.handleInput("\x1bp");
		expect(onPasteImage).toHaveBeenCalledTimes(1);
	});
	it("keeps configured app shortcuts reachable from Vim normal mode", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.retry", ["alt+r"]);
		editor.onRetry = onRetry;

		editor.handleInput("\x1br");

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("routes fragmented bracketed paste through Vim insert-mode undo", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setInputMode("vim");

		editor.handleInput("\x1b[200~");
		editor.handleInput("ignored");
		editor.handleInput("\x1b[201~");
		expect(editor.getText()).toBe("");

		editor.handleInput("i");
		editor.handleInput("\x1b[200~");
		editor.handleInput("pasted");
		editor.handleInput("\x1b[201~");
		editor.handleInput("!");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("pasted!");

		editor.handleInput("u");
		expect(editor.getText()).toBe("");
	});

	it("allows configured raw-text paste only from Vim insert mode", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onPasteTextRaw = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.clipboard.pasteTextRaw", ["alt+t"]);
		editor.onPasteTextRaw = onPasteTextRaw;

		editor.handleInput("\x1bt");
		expect(onPasteTextRaw).not.toHaveBeenCalled();

		editor.setText("text");
		editor.handleInput("v");
		expect(editor.getVimMode()).toBe("visual");
		editor.handleInput("\x1bt");
		expect(onPasteTextRaw).not.toHaveBeenCalled();
		editor.handleInput("\x1b");

		editor.handleInput("i");
		editor.handleInput("\x1bt");
		expect(onPasteTextRaw).toHaveBeenCalledTimes(1);
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
