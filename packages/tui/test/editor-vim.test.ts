import { describe, expect, it, vi } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

function createVimEditor(): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setInputMode("vim");
	return editor;
}

function typeText(editor: Editor, text: string): void {
	for (const char of text) editor.handleInput(char);
}

describe("Editor Vim input mode", () => {
	it("leaves default input behavior unchanged", () => {
		const editor = new Editor(defaultEditorTheme);

		typeText(editor, "hello");

		expect(editor.getText()).toBe("hello");
		expect(editor.getVimMode()).toBeUndefined();
	});

	it("starts in normal mode and enters text only from insert mode", () => {
		const editor = createVimEditor();

		typeText(editor, "zzz");
		expect(editor.getText()).toBe("");

		editor.handleInput("i");
		typeText(editor, "hello");
		expect(editor.getText()).toBe("hello");

		editor.handleInput("\x1b");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("undoes an insert session as one change", () => {
		const editor = createVimEditor();

		editor.handleInput("i");
		typeText(editor, "hello world");
		editor.handleInput("\x1b");
		editor.handleInput("u");

		expect(editor.getText()).toBe("");
	});

	it("keeps change-word whitespace and folds replacement text into one undo", () => {
		const editor = createVimEditor();
		editor.setText("one two");

		editor.handleInput("0");
		editor.handleInput("c");
		editor.handleInput("w");
		typeText(editor, "X");
		editor.handleInput("\x1b");

		expect(editor.getText()).toBe("X two");

		editor.handleInput("u");
		expect(editor.getText()).toBe("one two");
	});

	it("treats punctuation as a small-word motion target", () => {
		const editor = createVimEditor();
		editor.setText("foo.bar baz");

		editor.handleInput("0");
		editor.handleInput("w");
		expect(editor.getCursor()).toEqual({ line: 0, col: 3 });

		editor.handleInput("x");
		expect(editor.getText()).toBe("foobar baz");
	});

	it("supports zero-containing counts and counted gg", () => {
		const editor = createVimEditor();
		editor.setText(Array.from({ length: 12 }, (_, index) => String(index + 1)).join("\n"));

		editor.handleInput("g");
		editor.handleInput("g");
		typeText(editor, "10j");
		expect(editor.getCursor().line).toBe(10);

		typeText(editor, "3gg");
		expect(editor.getCursor().line).toBe(2);
	});

	it("supports counts after an operator", () => {
		const editor = createVimEditor();
		editor.setText("one two three");

		editor.handleInput("0");
		typeText(editor, "d2w");

		expect(editor.getText()).toBe("three");
	});

	it("applies counts to linewise deletes", () => {
		const editor = createVimEditor();
		editor.setText("one\ntwo\nthree\nfour");

		typeText(editor, "gg3dd");

		expect(editor.getText()).toBe("four");
	});

	it("does not wrap h and l across logical lines", () => {
		const editor = createVimEditor();
		editor.setText("a\nb");

		typeText(editor, "ggl");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

		editor.handleInput("G");
		editor.handleInput("h");
		expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
	});

	it("leaves arrow-key navigation available in normal mode", () => {
		const editor = createVimEditor();
		editor.setText("abc");

		editor.handleInput("0");
		editor.handleInput("\x1b[C");

		expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	});

	it("blocks default editing shortcuts in normal mode", () => {
		const editor = createVimEditor();
		editor.setText("abc");

		editor.handleInput("\x7f");
		editor.handleInput("\x1b[3~");
		editor.handleInput("\x15");
		editor.handleInput("\x0b");
		editor.handleInput("\n");

		expect(editor.getText()).toBe("abc");
	});

	it("deletes emoji and combining graphemes atomically", () => {
		const emoji = createVimEditor();
		emoji.setText("😀a");
		typeText(emoji, "0x");
		expect(emoji.getText()).toBe("a");

		const combining = createVimEditor();
		combining.setText("e\u0301x");
		typeText(combining, "0x");
		expect(combining.getText()).toBe("x");
	});

	it("preserves atomic placeholder invariants", () => {
		const editor = createVimEditor();
		editor.atomicTokenPattern = /\[Image #[^\]]+\]/g;
		editor.setText("[Image #1] x");

		typeText(editor, "0x");

		expect(editor.getText()).toBe(" x");
	});

	it("returns to normal mode after submitting from insert mode", () => {
		const editor = createVimEditor();
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;

		editor.handleInput("i");
		typeText(editor, "ship it");
		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledWith("ship it");
		expect(editor.getText()).toBe("");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("accepts bracketed paste only in insert mode and groups it with insert undo", () => {
		const editor = createVimEditor();
		const paste = "\x1b[200~pasted text\x1b[201~";

		editor.handleInput(paste);
		expect(editor.getText()).toBe("");

		editor.handleInput("i");
		editor.handleInput(paste);
		typeText(editor, "!");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("pasted text!");

		editor.handleInput("u");
		expect(editor.getText()).toBe("");
	});

	it("resets externally supplied text to an editable normal-mode cursor", () => {
		const editor = createVimEditor();
		editor.handleInput("i");

		editor.setText("abc");
		editor.handleInput("x");

		expect(editor.getVimMode()).toBe("normal");
		expect(editor.getText()).toBe("ab");
	});

	it("reports mode transitions for host status rendering", () => {
		const editor = createVimEditor();
		const onInputModeChange = vi.fn();
		editor.onInputModeChange = onInputModeChange;

		editor.handleInput("i");
		editor.handleInput("\x1b");

		expect(onInputModeChange).toHaveBeenNthCalledWith(1, "insert");
		expect(onInputModeChange).toHaveBeenNthCalledWith(2, "normal");
	});
});
