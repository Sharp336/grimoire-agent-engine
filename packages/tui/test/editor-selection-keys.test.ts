import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings";
import { defaultEditorTheme } from "./test-themes";

// Raw sequences confirmed against the native key parser.
const SHIFT_LEFT = "\x1b[1;2D";
const SHIFT_RIGHT = "\x1b[1;2C";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_HOME = "\x1b[1;2H";
const SHIFT_END = "\x1b[1;2F";
const SHIFT_CTRL_LEFT = "\x1b[1;6D";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const LINE_START = "\x01"; // ctrl+a
const NEWLINE = "\x1b[13;2~"; // shift+enter
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";
const ESC = "\x1b";

function editorWith(text: string): Editor {
	const e = new Editor(defaultEditorTheme);
	e.handleInput(text);
	return e;
}

describe("Editor shift-selection", () => {
	beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
	afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

	describe("extending", () => {
		it("shift+left selects the character before the cursor", () => {
			const e = editorWith("hello");
			e.handleInput(SHIFT_LEFT);
			expect(e.getSelectedText()).toBe("o");
		});

		it("shift+left twice selects two characters", () => {
			const e = editorWith("hello");
			e.handleInput(SHIFT_LEFT);
			e.handleInput(SHIFT_LEFT);
			expect(e.getSelectedText()).toBe("lo");
		});

		it("shift+right extends forward", () => {
			const e = editorWith("hello");
			e.handleInput(LINE_START);
			e.handleInput(SHIFT_RIGHT);
			e.handleInput(SHIFT_RIGHT);
			expect(e.getSelectedText()).toBe("he");
		});

		it("shift+home selects to line start", () => {
			const e = editorWith("hello");
			e.handleInput(SHIFT_HOME);
			expect(e.getSelectedText()).toBe("hello");
		});

		it("shift+end selects to line end", () => {
			const e = editorWith("hello");
			e.handleInput(LINE_START);
			e.handleInput(SHIFT_END);
			expect(e.getSelectedText()).toBe("hello");
		});

		it("shift+ctrl+left selects the previous word", () => {
			const e = editorWith("hello world");
			e.handleInput(SHIFT_CTRL_LEFT);
			expect(e.getSelectedText()).toBe("world");
		});

		it("shift+up extends across lines", () => {
			const e = new Editor(defaultEditorTheme);
			e.handleInput("ab");
			e.handleInput(NEWLINE);
			e.handleInput("cd");
			e.handleInput(LINE_START); // cursor at start of line 2
			e.handleInput(SHIFT_UP);
			expect(e.getSelectedText()).toBe("ab\n");
		});
	});

	describe("collapsing / clearing", () => {
		it("plain left collapses the selection to its start", () => {
			const e = editorWith("hello");
			e.handleInput(LINE_START);
			e.handleInput(SHIFT_RIGHT);
			e.handleInput(SHIFT_RIGHT); // selected "he", cursor at col 2
			e.handleInput(LEFT); // collapse to col 0
			expect(e.getSelectedText()).toBe("");
			e.handleInput("X");
			expect(e.getText()).toBe("Xhello");
		});

		it("plain right collapses the selection to its end", () => {
			const e = editorWith("hello");
			e.handleInput(LINE_START);
			e.handleInput(SHIFT_RIGHT);
			e.handleInput(SHIFT_RIGHT); // selected "he", cursor at col 2
			e.handleInput(RIGHT); // collapse to col 2
			expect(e.getSelectedText()).toBe("");
			e.handleInput("X");
			expect(e.getText()).toBe("heXllo");
		});

		it("escape clears the selection without changing the text", () => {
			const e = editorWith("hello");
			e.handleInput(SHIFT_LEFT);
			e.handleInput(SHIFT_LEFT);
			e.handleInput(ESC);
			expect(e.getSelectedText()).toBe("");
			expect(e.getText()).toBe("hello");
		});
	});

	describe("mutations replace the selection", () => {
		it("backspace deletes the selection", () => {
			const e = editorWith("hello");
			e.handleInput(SHIFT_LEFT);
			e.handleInput(SHIFT_LEFT); // "lo"
			e.handleInput(BACKSPACE);
			expect(e.getText()).toBe("hel");
			expect(e.getSelectedText()).toBe("");
		});

		it("delete removes the selection", () => {
			const e = editorWith("hello");
			e.handleInput(LINE_START);
			e.handleInput(SHIFT_RIGHT);
			e.handleInput(SHIFT_RIGHT); // "he"
			e.handleInput(DELETE);
			expect(e.getText()).toBe("llo");
		});

		it("typing a character replaces the selection", () => {
			const e = editorWith("hello");
			e.handleInput(SHIFT_LEFT);
			e.handleInput(SHIFT_LEFT); // "lo"
			e.handleInput("X");
			expect(e.getText()).toBe("helX");
		});
	});

	describe("no regression to history", () => {
		it("shift+up does not navigate history", () => {
			const e = new Editor(defaultEditorTheme);
			e.addToHistory("old prompt");
			e.handleInput("ab");
			e.handleInput(SHIFT_UP);
			expect(e.getText()).toBe("ab");
		});

		it("plain up still navigates history when at top with empty editor", () => {
			const e = new Editor(defaultEditorTheme);
			e.addToHistory("old prompt");
			e.handleInput(UP);
			expect(e.getText()).toBe("old prompt");
		});
	});
});

describe("Editor selection rendering", () => {
	beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
	afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

	const selTheme = { ...defaultEditorTheme, selection: (t: string) => `<S>${t}</S>` };

	it("wraps selected text before the cursor in the selection style", () => {
		const e = new Editor(selTheme);
		e.handleInput("hello");
		e.handleInput(LINE_START);
		e.handleInput(SHIFT_RIGHT);
		e.handleInput(SHIFT_RIGHT); // "he" selected, cursor on "l"
		expect(e.render(80).join("\n")).toContain("<S>he</S>");
	});

	it("wraps selected text after the cursor in the selection style", () => {
		const e = new Editor(selTheme);
		e.handleInput("hello");
		e.handleInput(SHIFT_LEFT);
		e.handleInput(SHIFT_LEFT); // "lo" selected, caret on "l", "o" highlighted
		expect(e.render(80).join("\n")).toContain("<S>o</S>");
	});

	it("highlights a selected line that does not contain the cursor", () => {
		const e = new Editor(selTheme);
		e.handleInput("abc");
		e.handleInput(NEWLINE);
		e.handleInput("def");
		e.handleInput(LEFT);
		e.handleInput(LEFT); // cursor at (1,1)
		e.handleInput(SHIFT_UP); // anchor (1,1), cursor (0,1); line 1 selected w/o cursor
		expect(e.render(80).join("\n")).toContain("<S>d</S>");
	});

	it("applies no selection style when nothing is selected", () => {
		const e = new Editor(selTheme);
		e.handleInput("hello");
		expect(e.render(80).join("\n")).not.toContain("<S>");
	});

	it("highlights the selection in hardware-cursor mode (as the real app uses)", () => {
		const e = new Editor(selTheme);
		e.setUseTerminalCursor(true);
		e.focused = true;
		e.handleInput("hello");
		e.handleInput(LINE_START);
		e.handleInput(SHIFT_RIGHT);
		e.handleInput(SHIFT_RIGHT); // "he" selected
		expect(e.render(80).join("\n")).toContain("<S>he</S>");
	});
});
