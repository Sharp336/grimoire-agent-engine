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

	it("lets Escape cancel a pending Vim command before interrupting the app", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.setInputMode("vim");
		editor.setText("abc");
		editor.onEscape = onEscape;
		editor.handleInput("d");

		editor.handleInput("\x1b");

		expect(editor.getVimMode()).toBe("normal");
		expect(editor.getText()).toBe("abc");
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

	it("allows configured STT toggles only from Vim insert mode", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onSTTToggle = vi.fn(() => editor.insertText("transcript"));
		editor.setInputMode("vim");
		editor.setActionKeys("app.stt.toggle", ["alt+s"]);
		editor.onSTTToggle = onSTTToggle;
		editor.setText("one two");

		editor.handleInput("0");
		editor.handleInput("d");
		editor.handleInput("\x1bs");
		editor.handleInput("w");
		expect(onSTTToggle).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("one two");

		editor.handleInput("v");
		editor.handleInput("\x1bs");
		expect(onSTTToggle).not.toHaveBeenCalled();
		editor.handleInput("\x1b");

		editor.handleInput("i");
		editor.handleInput("\x1bs");
		expect(onSTTToggle).toHaveBeenCalledTimes(1);
		editor.handleInput("!");
		editor.handleInput("\x1b");
		editor.handleInput("u");
		expect(editor.getText()).toBe("one two");
	});

	it("allows clipboard image paste only from Vim insert mode", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const onPasteImage = vi.fn(async () => {
			editor.insertText("[Image] ");
			return true;
		});
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
		await Promise.resolve();
		await Promise.resolve();
		editor.handleInput("!");
		editor.handleInput("\x1b");
		editor.handleInput("u");
		expect(editor.getText()).toBe("text");
	});

	it("queues Vim submit until a configured image paste settles", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const image = Promise.withResolvers<void>();
		const onSubmit = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.clipboard.pasteImage", ["alt+p"]);
		editor.onPasteImage = async () => {
			await image.promise;
			editor.insertText("[Image] ");
			return true;
		};
		editor.onSubmit = onSubmit;
		editor.handleInput("i");

		editor.handleInput("\x1bp");
		editor.handleInput("\r");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getVimMode()).toBe("insert");

		image.resolve();
		await image.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(onSubmit).toHaveBeenCalledWith("[Image]");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("lets Vim escape cancel queued input during a configured image paste", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const image = Promise.withResolvers<void>();
		const onSubmit = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.clipboard.pasteImage", ["alt+p"]);
		editor.onPasteImage = async () => {
			await image.promise;
			if (editor.getVimMode() === "insert") editor.insertText("[Image] ");
			return true;
		};
		editor.onSubmit = onSubmit;
		editor.setText("draft");
		editor.handleInput("i");

		editor.handleInput("\x1bp");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(editor.getVimMode()).toBe("normal");

		image.resolve();
		await image.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(editor.getText()).toBe("draft");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("lets default-mode cancellation shortcuts bypass a configured image paste", async () => {
		const cases = [
			{
				name: "interrupt",
				action: "app.interrupt",
				key: "escape",
				input: "\x1b",
				wire: (editor: CustomEditor, callback: () => void) => {
					editor.onEscape = callback;
				},
			},
			{
				name: "clear",
				action: "app.clear",
				key: "ctrl+c",
				input: "\x03",
				wire: (editor: CustomEditor, callback: () => void) => {
					editor.onClear = callback;
				},
			},
			{
				name: "exit",
				action: "app.exit",
				key: "ctrl+d",
				input: "\x04",
				wire: (editor: CustomEditor, callback: () => void) => {
					editor.onExit = callback;
				},
			},
		] as const;

		for (const testCase of cases) {
			const editor = new CustomEditor(getEditorTheme());
			const image = Promise.withResolvers<void>();
			const onCancel = vi.fn();
			editor.setActionKeys("app.clipboard.pasteImage", ["alt+p"]);
			editor.setActionKeys(testCase.action, [testCase.key]);
			editor.onPasteImage = () => image.promise.then(() => true);
			testCase.wire(editor, onCancel);

			editor.handleInput("\x1bp");
			editor.handleInput("queued");
			editor.handleInput(testCase.input);

			expect(onCancel, testCase.name).toHaveBeenCalledTimes(1);
			expect(editor.getText(), testCase.name).toBe("");

			image.resolve();
			await image.promise;
			await Promise.resolve();
			expect(editor.getText(), testCase.name).toBe("");
		}
	});

	it("releases the async paste gate when Vim Escape cancels", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const image = Promise.withResolvers<void>();
		const onEscape = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.clipboard.pasteImage", ["alt+p"]);
		editor.onPasteImage = () => image.promise.then(() => true);
		editor.onEscape = onEscape;
		editor.setText("draft");
		editor.handleInput("i");

		editor.handleInput("\x1bp");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(editor.getVimMode()).toBe("normal");

		editor.handleInput("\x1b");
		expect(onEscape).toHaveBeenCalledTimes(1);
		editor.handleInput("i");
		editor.handleInput("!");
		expect(editor.getText()).toBe("draf!t");

		image.resolve();
		await image.promise;
		await Promise.resolve();
		expect(editor.getText()).toBe("draf!t");
	});

	it("does not let a canceled paste settlement release a newer paste gate", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const onSubmit = vi.fn();
		let pasteNumber = 0;
		editor.setInputMode("vim");
		editor.setActionKeys("app.clipboard.pasteImage", ["alt+p"]);
		editor.onPasteImage = () => (++pasteNumber === 1 ? first.promise : second.promise).then(() => true);
		editor.onSubmit = onSubmit;
		editor.handleInput("i");

		editor.handleInput("\x1bp");
		editor.handleInput("\x1b");
		editor.handleInput("i");
		editor.handleInput("\x1bp");
		editor.handleInput("\r");

		first.resolve();
		await first.promise;
		await Promise.resolve();
		expect(onSubmit).not.toHaveBeenCalled();

		second.resolve();
		await second.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});
	it("keeps configured app shortcuts reachable from Vim normal mode", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.retry", ["alt+r"]);
		editor.onRetry = onRetry;
		editor.setText("one two");
		editor.handleInput("0");
		editor.handleInput("d");

		editor.handleInput("\x1br");
		editor.handleInput("w");

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("one two");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("routes fragmented bracketed paste through Vim insert-mode undo", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setInputMode("vim");

		editor.handleInput("\x1b[200~");
		editor.handleInput("ignored");
		editor.handleInput("\x1b[201~");
		expect(editor.getText()).toBe("");

		editor.setText("one two");
		editor.handleInput("0");
		editor.handleInput("d");
		editor.handleInput("\x1b[200~ignored\x1b[201~");
		editor.handleInput("w");
		expect(editor.getText()).toBe("one two");
		editor.setText("");

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

	it("undoes and redoes pasted image sidecars with their Vim marker", () => {
		const editor = new CustomEditor(getEditorTheme());
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		editor.setInputMode("vim");
		editor.handleInput("i");
		editor.prepareVimInsertMutation();
		editor.pendingImages.push(image);
		editor.pendingImageLinks.push("local://draft.png");
		editor.imageLinks = editor.pendingImageLinks;
		editor.insertText("[Image #1] ");
		editor.handleInput("\x1b");

		editor.handleInput("u");
		expect(editor.getText()).toBe("");
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
		expect(editor.imageLinks).toBeUndefined();

		editor.handleInput("\x12");
		expect(editor.getText()).toBe("[Image #1] ");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(editor.imageLinks).toEqual(["local://draft.png"]);
	});

	it("stops a multi-image path paste after Vim Escape cancels its generation", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const firstImage = Promise.withResolvers<void>();
		const onPasteImagePath = vi.fn(async () => {
			if (onPasteImagePath.mock.calls.length === 1) await firstImage.promise;
			else editor.insertText("[stale image] ");
		});
		editor.setInputMode("vim");
		editor.onPasteImagePath = onPasteImagePath;
		editor.setText("draft");
		editor.handleInput("i");

		editor.handleInput("\x1b[200~/tmp/first.png\n/tmp/second.png\x1b[201~");
		expect(onPasteImagePath).toHaveBeenCalledTimes(1);
		editor.handleInput("\x1b");
		editor.handleInput("i");
		editor.handleInput("!");
		firstImage.resolve();
		await firstImage.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(onPasteImagePath).toHaveBeenCalledTimes(1);
		expect(editor.getText()).not.toContain("[stale image]");
		expect(editor.getVimMode()).toBe("insert");
	});

	it("allows configured raw-text paste only from Vim insert mode", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const onPasteTextRaw = vi.fn(() => editor.insertText("pasted"));
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
		await Promise.resolve();
		await Promise.resolve();
		editor.handleInput("!");
		editor.handleInput("\x1b");
		editor.handleInput("u");
		expect(editor.getText()).toBe("text");
	});

	it("queues Vim submit until a configured raw paste settles", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const clipboard = Promise.withResolvers<void>();
		const onSubmit = vi.fn();
		editor.setInputMode("vim");
		editor.setActionKeys("app.clipboard.pasteTextRaw", ["alt+t"]);
		editor.onPasteTextRaw = async () => {
			await clipboard.promise;
			editor.insertText("pasted");
		};
		editor.onSubmit = onSubmit;
		editor.handleInput("i");

		editor.handleInput("\x1bt");
		editor.handleInput("\r");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getVimMode()).toBe("insert");

		clipboard.resolve();
		await clipboard.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(onSubmit).toHaveBeenCalledWith("pasted");
		expect(editor.getVimMode()).toBe("normal");
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
