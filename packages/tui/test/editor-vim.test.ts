import { afterEach, describe, expect, it, vi } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import { defaultEditorTheme } from "./test-themes";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

function createVimEditor(): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setInputMode("vim");
	return editor;
}

function typeText(editor: Editor, text: string): void {
	for (const char of text) editor.handleInput(char);
}
const VIM_TERMINAL_ENV_KEYS = ["TERM", "TMUX", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"] as const;

const VIM_TERMINAL_ENVIRONMENTS: ReadonlyArray<{
	name: string;
	env: Partial<Record<(typeof VIM_TERMINAL_ENV_KEYS)[number], string>>;
}> = [
	{
		name: "tmux",
		env: { TERM: "tmux-256color", TMUX: "/tmp/tmux-1000/default,1234,0" },
	},
	{
		name: "SSH",
		env: {
			TERM: "xterm-256color",
			SSH_CONNECTION: "192.0.2.10 54321 192.0.2.20 22",
			SSH_TTY: "/dev/pts/7",
			SSH_CLIENT: "192.0.2.10 54321 22",
		},
	},
	{
		name: "tmux over SSH",
		env: {
			TERM: "tmux-256color",
			TMUX: "/tmp/tmux-1000/default,1234,0",
			SSH_CONNECTION: "192.0.2.10 54321 192.0.2.20 22",
			SSH_TTY: "/dev/pts/7",
			SSH_CLIENT: "192.0.2.10 54321 22",
		},
	},
];

function withVimTerminalEnvironment(env: (typeof VIM_TERMINAL_ENVIRONMENTS)[number]["env"], run: () => void): void {
	const saved = Object.fromEntries(VIM_TERMINAL_ENV_KEYS.map(key => [key, process.env[key]]));
	try {
		for (const key of VIM_TERMINAL_ENV_KEYS) delete process.env[key];
		for (const [key, value] of Object.entries(env)) process.env[key] = value;
		run();
	} finally {
		for (const key of VIM_TERMINAL_ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
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

	it("dispatches batched printable input through Vim modes", () => {
		const inserted = createVimEditor();
		inserted.handleInput("ihello");
		expect(inserted.getText()).toBe("hello");
		expect(inserted.getVimMode()).toBe("insert");

		inserted.handleInput("\x1b");
		inserted.handleInput("u");
		expect(inserted.getText()).toBe("");

		const deleted = createVimEditor();
		deleted.setText("one\ntwo");
		deleted.handleInput("ggdd");
		expect(deleted.getText()).toBe("two");
		expect(deleted.getVimMode()).toBe("normal");

		const grapheme = createVimEditor();
		grapheme.handleInput("e\u0301");
		expect(grapheme.getText()).toBe("");
	});

	it("undoes an insert session as one change", () => {
		const editor = createVimEditor();

		editor.handleInput("i");
		typeText(editor, "hello world");
		editor.handleInput("\x1b");
		editor.handleInput("u");

		expect(editor.getText()).toBe("");
	});

	it("undoes replacement text after changing an empty range", () => {
		const editor = createVimEditor();

		typeText(editor, "Creplacement\u001b");
		expect(editor.getText()).toBe("replacement");

		editor.handleInput("u");
		expect(editor.getText()).toBe("");
	});

	it("clamps the normal cursor after the configured base undo", () => {
		const editor = createVimEditor();
		editor.setText("abc");
		typeText(editor, "A!\u001b");

		editor.handleInput("\x1f");
		editor.handleInput("x");

		expect(editor.getText()).toBe("ab");
		expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	});

	it("redoes an undone change with Ctrl-R in normal mode", () => {
		const editor = createVimEditor();

		typeText(editor, "ihello world\u001bu");
		expect(editor.getText()).toBe("");

		editor.handleInput("\u0012");
		expect(editor.getText()).toBe("hello world");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("stops huge undo and redo counts when history is exhausted", () => {
		const editor = createVimEditor();
		typeText(editor, "ia\u001bab\u001b");
		expect(editor.getText()).toBe("ab");

		typeText(editor, "999999999999u");
		expect(editor.getText()).toBe("");

		typeText(editor, "999999999999");
		editor.handleInput("\u0012");
		expect(editor.getText()).toBe("ab");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("caps huge word and paragraph counts without spinning at buffer boundaries", () => {
		const word = createVimEditor();
		word.setText("one");
		typeText(word, "999999999999e");
		expect(word.getCursor()).toEqual({ line: 0, col: 2 });

		const paragraph = createVimEditor();
		paragraph.setText("one\n\ntwo");
		typeText(paragraph, "gg999999999999dap");
		expect(paragraph.getText()).toBe("");
		expect(paragraph.getVimMode()).toBe("normal");
	});

	it("caps multiplied operator counts before applying them", () => {
		const editor = createVimEditor();
		editor.setText(Array.from({ length: 1100 }, (_, index) => `line ${index}`).join("\n"));
		typeText(editor, "gg2d600d");

		expect(editor.getLines()).toHaveLength(100);
		expect(editor.getLines()[0]).toBe("line 1000");
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

	it("changes the inner word under the cursor and groups replacement undo", () => {
		const editor = createVimEditor();
		editor.setText("one target two");

		typeText(editor, "0wllciw");
		expect(editor.getText()).toBe("one  two");
		expect(editor.getVimMode()).toBe("insert");

		typeText(editor, "replacement\u001b");
		expect(editor.getText()).toBe("one replacement two");

		editor.handleInput("u");
		expect(editor.getText()).toBe("one target two");
	});

	it("deletes the inner word under the cursor", () => {
		const editor = createVimEditor();
		editor.setText("one target two");

		typeText(editor, "0wlldiw");

		expect(editor.getText()).toBe("one  two");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("deletes a word together with its trailing whitespace", () => {
		const editor = createVimEditor();
		editor.setText("one target two");

		typeText(editor, "0wlldaw");

		expect(editor.getText()).toBe("one two");
	});

	it("deletes paragraphs at the start, middle, and end of the prompt", () => {
		const first = createVimEditor();
		first.setText("one\ntwo\n\nthree\nfour");
		typeText(first, "ggdap");
		expect(first.getText()).toBe("three\nfour");

		const middle = createVimEditor();
		middle.setText("one\n\ntwo\n\nthree");
		typeText(middle, "gg2jdap");
		expect(middle.getText()).toBe("one\n\nthree");

		const last = createVimEditor();
		last.setText("one\ntwo\n\nthree\nfour");
		typeText(last, "Gdap");
		expect(last.getText()).toBe("one\ntwo");
	});

	it("deletes and changes inner paragraphs without consuming surrounding blank lines", () => {
		const deleted = createVimEditor();
		deleted.setText("one\ntwo\n\nthree");
		typeText(deleted, "ggdip");
		expect(deleted.getText()).toBe("\nthree");

		const changed = createVimEditor();
		changed.setText("one\ntwo\n\nthree");
		typeText(changed, "ggcipreplacement\u001b");
		expect(changed.getText()).toBe("replacement\n\nthree");
		changed.handleInput("u");
		expect(changed.getText()).toBe("one\ntwo\n\nthree");
	});

	it("changes a paragraph linewise and groups replacement undo", () => {
		const editor = createVimEditor();
		editor.setText("one\n\ntwo\n\nthree");

		typeText(editor, "gg2jcap");
		expect(editor.getVimMode()).toBe("insert");
		typeText(editor, "replacement\u001b");
		expect(editor.getText()).toBe("one\n\nreplacement\nthree");

		editor.handleInput("u");
		expect(editor.getText()).toBe("one\n\ntwo\n\nthree");
	});
	it("selects the inner paragraph with vip", () => {
		const editor = createVimEditor();
		editor.setText("one\n\ntwo\nthree\n\nfour");

		typeText(editor, "gg2jvip");

		expect(editor.getVimMode()).toBe("visual");
		const rendered = editor.render(40).join("\n");
		expect(rendered).toContain("\u001b[7mtwo\u001b[0m");
		expect(rendered).toContain("\u001b[7mthree\u001b[0m");

		editor.handleInput("\u001b");
		expect(editor.getVimMode()).toBe("normal");
	});
	it("keeps v characterwise while viw selects only the current word", () => {
		const editor = createVimEditor();
		editor.setText("one two");

		typeText(editor, "0v");
		expect(editor.getVimMode()).toBe("visual");
		const characterRender = editor.render(40).join("\n");
		expect(characterRender).toContain("\u001b[7mo\u001b[0mne two");
		expect(characterRender).not.toContain("\u001b[7mone\u001b[0m");

		editor.handleInput("d");
		expect(editor.getText()).toBe("ne two");
		expect(editor.getVimMode()).toBe("normal");

		editor.setText("one two");
		typeText(editor, "0viw");
		const wordRender = editor.render(40).join("\n");
		expect(wordRender).toContain("\u001b[7mone\u001b[0m two");

		editor.handleInput("d");
		expect(editor.getText()).toBe(" two");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("changes a viw selection and groups replacement undo", () => {
		const editor = createVimEditor();
		editor.setText("one two");

		typeText(editor, "0viwc");

		expect(editor.getText()).toBe(" two");
		expect(editor.getVimMode()).toBe("insert");

		typeText(editor, "changed");
		editor.handleInput("\u001b");
		expect(editor.getText()).toBe("changed two");

		editor.handleInput("u");
		expect(editor.getText()).toBe("one two");
	});

	it("selects and highlights lines with Shift-V", () => {
		const editor = createVimEditor();
		editor.setText("one\ntwo\nthree");

		typeText(editor, "ggVj");

		expect(editor.getVimMode()).toBe("visual");
		const rendered = editor.render(40).join("\n");
		expect(rendered).toContain("\u001b[7mone\u001b[0m");
		expect(rendered).toContain("\u001b[7mtwo\u001b[0m");
		expect(rendered).not.toContain("\u001b[7mthree\u001b[0m");

		editor.handleInput("d");
		expect(editor.getText()).toBe("three");
		expect(editor.getVimMode()).toBe("normal");
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

	it("applies G and gg as linewise operator motions", () => {
		const toEnd = createVimEditor();
		toEnd.setText("one\ntwo\nthree");
		typeText(toEnd, "ggdG");
		expect(toEnd.getText()).toBe("");

		const toStart = createVimEditor();
		toStart.setText("one\ntwo\nthree");
		typeText(toStart, "Gdgg");
		expect(toStart.getText()).toBe("");

		const countedEnd = createVimEditor();
		countedEnd.setText("one\ntwo\nthree\nfour");
		typeText(countedEnd, "ggd2G");
		expect(countedEnd.getText()).toBe("three\nfour");

		const countedStart = createVimEditor();
		countedStart.setText("one\ntwo\nthree\nfour");
		typeText(countedStart, "G2dgg");
		expect(countedStart.getText()).toBe("one");

		const changed = createVimEditor();
		changed.setText("one\ntwo\nthree");
		typeText(changed, "Gcggreplacement\u001b");
		expect(changed.getText()).toBe("replacement");
		changed.handleInput("u");
		expect(changed.getText()).toBe("one\ntwo\nthree");
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

	it.each([
		{ name: "Right Arrow", key: "\x1b[C" },
		{ name: "End", key: "\x1b[F" },
		{ name: "Ctrl-E", key: "\x05" },
	])("keeps the normal cursor on a grapheme after $name fallback", ({ key }) => {
		const editor = createVimEditor();
		editor.setText("abc");
		editor.handleInput("$");

		editor.handleInput(key);
		editor.handleInput("x");

		expect(editor.getText()).toBe("ab");
	});

	it("blocks remapped base mutations in Vim normal mode", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteToLineEnd": "alt+g" }));
		const editor = createVimEditor();
		editor.setText("abc");
		editor.handleInput("0");

		editor.handleInput("\x1bg");

		expect(editor.getText()).toBe("abc");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("groups remapped base mutations into the Vim insert undo session", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteToLineEnd": "alt+g" }));
		const editor = createVimEditor();
		editor.setText("abc");
		typeText(editor, "0i");

		editor.handleInput("\x1bg");
		typeText(editor, "X\u001bu");

		expect(editor.getText()).toBe("abc");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("clears pending counts and operators before non-command keys", () => {
		const counted = createVimEditor();
		counted.setText("abcde");
		typeText(counted, "03");
		counted.handleInput("\x1b[C");
		counted.handleInput("x");
		expect(counted.getText()).toBe("acde");

		const operated = createVimEditor();
		operated.setText("one two");
		typeText(operated, "0d");
		operated.handleInput("\x1b[C");
		operated.handleInput("w");
		expect(operated.getText()).toBe("one two");
		expect(operated.getCursor()).toEqual({ line: 0, col: 4 });

		const blocked = createVimEditor();
		blocked.setText("abcde");
		typeText(blocked, "03");
		blocked.handleInput("\t");
		blocked.handleInput("x");
		expect(blocked.getText()).toBe("bcde");

		const undone = createVimEditor();
		undone.setText("one two");
		typeText(undone, "0xd");
		undone.handleInput("\x1f");
		undone.handleInput("w");
		expect(undone.getText()).toBe("one two");
		expect(undone.getCursor()).toEqual({ line: 0, col: 4 });

		const redone = createVimEditor();
		redone.setText("one two");
		typeText(redone, "0d");
		redone.handleInput("\x12");
		redone.handleInput("w");
		expect(redone.getText()).toBe("one two");
		expect(redone.getCursor()).toEqual({ line: 0, col: 4 });

		const jumped = createVimEditor();
		jumped.setText("abc");
		jumped.handleInput("g");
		jumped.handleInput("\x12");
		jumped.handleInput("x");
		expect(jumped.getText()).toBe("ab");

		const visual = createVimEditor();
		visual.setText("abc");
		typeText(visual, "0vi");
		visual.handleInput("\x12");
		visual.handleInput("d");
		expect(visual.getText()).toBe("bc");
	});

	it.each([
		{ name: "Right Arrow", text: "abc", start: "0", key: "\x1b[C", expected: "c" },
		{ name: "Left Arrow", text: "abc", start: "$", key: "\x1b[D", expected: "a" },
		{ name: "Down Arrow", text: "a\nb", start: "gg", key: "\x1b[B", expected: "" },
		{ name: "Up Arrow", text: "a\nb", start: "G", key: "\x1b[A", expected: "" },
		{ name: "End", text: "abc", start: "0", key: "\x1b[F", expected: "" },
		{ name: "Ctrl-E", text: "abc", start: "0", key: "\x05", expected: "" },
		{ name: "Home", text: "abc", start: "$", key: "\x1b[H", expected: "" },
		{ name: "Ctrl-A", text: "abc", start: "$", key: "\x01", expected: "" },
		{ name: "Alt-Right", text: "one two", start: "0", key: "\x1bf", expected: "wo" },
		{ name: "Alt-Left", text: "one two", start: "$", key: "\x1bb", expected: "one " },
	])("extends visual selections with $name", ({ text, start, key, expected }) => {
		const editor = createVimEditor();
		editor.setText(text);
		typeText(editor, start);
		editor.handleInput("v");

		editor.handleInput(key);
		editor.handleInput("d");

		expect(editor.getText()).toBe(expected);
		expect(editor.getVimMode()).toBe("normal");
	});

	it("clears pending visual text objects before navigation", () => {
		const editor = createVimEditor();
		editor.setText("abc");
		typeText(editor, "0vi");

		editor.handleInput("\x1b[C");
		editor.handleInput("d");

		expect(editor.getText()).toBe("c");
		expect(editor.getVimMode()).toBe("normal");
	});

	it.each([
		{ name: "line start", text: "abc", start: "$", motion: "0", expected: "" },
		{ name: "line end", text: "abc", start: "0", motion: "$", expected: "" },
		{ name: "first non-blank", text: "  abc", start: "$", motion: "^", expected: "  " },
		{ name: "next word", text: "one two", start: "0", motion: "w", expected: "wo" },
		{ name: "previous word", text: "one two", start: "$", motion: "b", expected: "one " },
		{ name: "word end", text: "one two", start: "0", motion: "e", expected: " two" },
		{ name: "last line", text: "one\ntwo\nthree", start: "gg", motion: "G", expected: "hree" },
		{ name: "first line", text: "one\ntwo\nthree", start: "G", motion: "gg", expected: "hree" },
		{ name: "counted words", text: "one two three", start: "0", motion: "2w", expected: "hree" },
	])("extends visual selections to $name with printable motions", ({ text, start, motion, expected }) => {
		const editor = createVimEditor();
		editor.setText(text);
		typeText(editor, start);
		editor.handleInput("v");

		typeText(editor, motion);
		editor.handleInput("d");

		expect(editor.getText()).toBe(expected);
		expect(editor.getVimMode()).toBe("normal");
	});

	it.each([
		{ name: "Down Arrow", start: "gg", key: "\x1b[B", expected: "three" },
		{ name: "Up Arrow", start: "G", key: "\x1b[A", expected: "one" },
	])("extends linewise visual selections with $name", ({ start, key, expected }) => {
		const editor = createVimEditor();
		editor.setText("one\ntwo\nthree");
		typeText(editor, start);
		editor.handleInput("V");

		editor.handleInput(key);
		editor.handleInput("d");

		expect(editor.getText()).toBe(expected);
		expect(editor.getVimMode()).toBe("normal");
	});

	it.each([
		{
			name: "PageDown",
			start: "gg",
			key: "\x1b[6~",
			cursor: { line: 0, col: 0 },
			expected: "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9",
		},
		{
			name: "PageUp",
			start: "G",
			key: "\x1b[5~",
			cursor: { line: 9, col: 0 },
			expected: "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8",
		},
	])("keeps $name from bypassing visual selection tracking", ({ start, key, cursor, expected }) => {
		const editor = createVimEditor();
		editor.setMaxHeight(6);
		editor.setText("l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9");
		typeText(editor, start);
		editor.handleInput("V");

		editor.handleInput(key);
		expect(editor.getCursor()).toEqual(cursor);
		editor.handleInput("d");

		expect(editor.getText()).toBe(expected);
		expect(editor.getVimMode()).toBe("normal");
	});

	it.each([
		{ mode: "normal", enterMode: "" },

		{ mode: "visual", enterMode: "0v" },
	])("blocks modified newlines in $mode mode", ({ enterMode }) => {
		for (const key of ["\x1b\r", "\x1b[13;2~"]) {
			const editor = createVimEditor();
			editor.setText("abc");
			typeText(editor, enterMode);

			editor.handleInput(key);

			expect(editor.getText()).toBe("abc");
		}
	});

	it("leaves visual mode before applying a base-editor undo", () => {
		const editor = createVimEditor();
		typeText(editor, "iabc");
		editor.handleInput("\x1b");
		typeText(editor, "0v");

		editor.handleInput("\x1f");

		expect(editor.getText()).toBe("");
		expect(editor.getVimMode()).toBe("normal");
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

	it("finishes the insert session before a direct submit", () => {
		const editor = createVimEditor();
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;
		typeText(editor, "ifirst");

		editor.submit();

		expect(onSubmit).toHaveBeenCalledWith("first");
		expect(editor.getVimMode()).toBe("normal");
		typeText(editor, "inext\u001b");
		editor.handleInput("u");
		expect(editor.getText()).toBe("");
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
	it("distinguishes small-word and WORD motions", () => {
		const editor = createVimEditor();
		editor.setText("foo.bar baz");

		typeText(editor, "0e");
		expect(editor.getCursor().col).toBe(2);
		editor.handleInput("e");
		expect(editor.getCursor().col).toBe(3);

		editor.handleInput("0");
		editor.handleInput("E");
		expect(editor.getCursor().col).toBe(6);
		editor.handleInput("W");
		expect(editor.getCursor().col).toBe(8);
		editor.handleInput("B");
		expect(editor.getCursor().col).toBe(0);
	});

	it("supports backward, inclusive-end, line-start, and line-end delete motions", () => {
		const backward = createVimEditor();
		backward.setText("one two");
		typeText(backward, "0wdb");
		expect(backward.getText()).toBe("two");

		const inclusiveEnd = createVimEditor();
		inclusiveEnd.setText("one two");
		typeText(inclusiveEnd, "0de");
		expect(inclusiveEnd.getText()).toBe(" two");

		const lineStart = createVimEditor();
		lineStart.setText("one two");
		typeText(lineStart, "0wd0");
		expect(lineStart.getText()).toBe("two");

		const lineEnd = createVimEditor();
		lineEnd.setText("one two");
		typeText(lineEnd, "0wd$");
		expect(lineEnd.getText()).toBe("one ");
	});

	it.each([
		{ command: "dl", expected: "bc", mode: "normal" },
		{ command: "d2l", expected: "c", mode: "normal" },
		{ command: "clX\u001b", expected: "Xbc", mode: "normal" },
		{ command: "c2lX\u001b", expected: "Xc", mode: "normal" },
	])("applies $command to exactly its rightward character count", ({ command, expected, mode }) => {
		const editor = createVimEditor();
		editor.setText("abc");
		typeText(editor, `0${command}`);

		expect(editor.getText()).toBe(expected);
		expect(editor.getVimMode()).toBe(mode);
	});

	it("counts graphemes in rightward operator motions", () => {
		const editor = createVimEditor();
		editor.setText("ae\u0301c");

		typeText(editor, "0d2l");

		expect(editor.getText()).toBe("c");
	});

	it("multiplies counts before and after operators", () => {
		const editor = createVimEditor();
		editor.setText("one two three four five six");

		typeText(editor, "02d2w");

		expect(editor.getText()).toBe("five six");
	});

	it("changes whole lines without joining the following line", () => {
		const editor = createVimEditor();
		editor.setText("one\ntwo\nthree");

		typeText(editor, "ggcc");
		typeText(editor, "replacement");
		editor.handleInput("\x1b");

		expect(editor.getText()).toBe("replacement\ntwo\nthree");
		editor.handleInput("u");
		expect(editor.getText()).toBe("one\ntwo\nthree");
	});

	it("supports insert-at-cursor, first-nonblank, and line-end entry points", () => {
		const afterCursor = createVimEditor();
		afterCursor.setText("one");
		typeText(afterCursor, "0aX\u001b");
		expect(afterCursor.getText()).toBe("oXne");

		const firstNonBlank = createVimEditor();
		firstNonBlank.setText("  one");
		typeText(firstNonBlank, "IX\u001b");
		expect(firstNonBlank.getText()).toBe("  Xone");

		const lineEnd = createVimEditor();
		lineEnd.setText("one");
		typeText(lineEnd, "AX\u001b");
		expect(lineEnd.getText()).toBe("oneX");
	});

	it("opens lines above and below and undoes each insert session atomically", () => {
		const below = createVimEditor();
		below.setText("one\ntwo");
		typeText(below, "ggo");
		typeText(below, "middle");
		below.handleInput("\x1b");
		expect(below.getText()).toBe("one\nmiddle\ntwo");
		below.handleInput("u");
		expect(below.getText()).toBe("one\ntwo");

		const above = createVimEditor();
		above.setText("one\ntwo");
		typeText(above, "ggO");
		typeText(above, "top");
		above.handleInput("\x1b");
		expect(above.getText()).toBe("top\none\ntwo");
	});

	it.each(["o", "O"] as const)("limits huge %s counts to 1,000 new lines", command => {
		const editor = createVimEditor();
		editor.setText("seed");

		typeText(editor, `999999999999${command}`);

		expect(editor.getVimMode()).toBe("insert");
		expect(editor.getLines()).toHaveLength(1001);

		editor.handleInput("\u001b");
		editor.handleInput("u");
		expect(editor.getText()).toBe("seed");
	});

	it("applies first-nonblank and counted line-end motions", () => {
		const editor = createVimEditor();
		editor.setText("  one\n x");

		typeText(editor, "gg^");
		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });

		typeText(editor, "2$");
		expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
	});

	it("undoes direct normal-mode edits through the shared undo stack", () => {
		const editor = createVimEditor();
		editor.setText("abc");

		typeText(editor, "0x");
		expect(editor.getText()).toBe("bc");
		editor.handleInput("u");

		expect(editor.getText()).toBe("abc");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("keeps history navigation usable from normal mode", () => {
		const editor = createVimEditor();
		editor.addToHistory("recalled");
		editor.setText("");

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recalled");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		editor.handleInput("x");

		expect(editor.getText()).toBe("ecalled");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("cancels autocomplete before leaving Vim insert mode", async () => {
		const editor = createVimEditor();
		const { promise, resolve } = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "/help", value: "/help" }], prefix: "/" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.onAutocompleteUpdate = resolve;

		typeText(editor, "i/");
		await promise;
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getVimMode()).toBe("normal");
		expect(editor.getText()).toBe("/");
	});

	it("invalidates pending autocomplete before leaving Vim insert mode", async () => {
		const editor = createVimEditor();
		const request = Promise.withResolvers<{
			items: Array<{ label: string; value: string }>;
			prefix: string;
		}>();
		editor.setAutocompleteProvider({
			getSuggestions() {
				return request.promise;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		typeText(editor, "i/");
		expect(editor.isShowingAutocomplete()).toBe(false);

		editor.handleInput("\x1b");
		request.resolve({ items: [{ label: "/help", value: "/help" }], prefix: "/" });
		await request.promise;
		await Promise.resolve();

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getVimMode()).toBe("normal");
	});

	it("invalidates pending autocomplete before submitting from Vim insert mode", async () => {
		const editor = createVimEditor();
		const onSubmit = vi.fn();
		const request = Promise.withResolvers<{
			items: Array<{ label: string; value: string }>;
			prefix: string;
		}>();
		editor.onSubmit = onSubmit;
		editor.setAutocompleteProvider({
			getSuggestions() {
				return request.promise;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		typeText(editor, "i@");

		editor.handleInput("\r");
		request.resolve({ items: [{ label: "@file", value: "@file" }], prefix: "@" });
		await request.promise;
		await Promise.resolve();

		expect(onSubmit).toHaveBeenCalledWith("@");
		expect(editor.getText()).toBe("");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getVimMode()).toBe("normal");
	});

	it("keeps Vim normal-mode undo and redo from reopening autocomplete", async () => {
		const editor = createVimEditor();
		const getSuggestions = vi.fn(async () => ({
			items: [{ label: "/help", value: "/help" }],
			prefix: "/",
		}));
		const { promise, resolve } = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			getSuggestions,
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.onAutocompleteUpdate = resolve;
		typeText(editor, "i/");
		await promise;
		editor.handleInput("\x1b");
		const callsBeforeRestore = getSuggestions.mock.calls.length;

		editor.handleInput("u");
		expect(editor.getText()).toBe("");
		editor.handleInput("\x12");
		expect(editor.getText()).toBe("/");
		editor.handleInput("x");
		editor.handleInput("u");

		expect(editor.getText()).toBe("/");
		expect(getSuggestions).toHaveBeenCalledTimes(callsBeforeRestore);
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getVimMode()).toBe("normal");
	});

	it("cancels active autocomplete when enabling Vim mode", async () => {
		const editor = new Editor(defaultEditorTheme);
		const { promise, resolve } = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "/help", value: "/help" }], prefix: "/" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.onAutocompleteUpdate = resolve;
		editor.handleInput("/");
		await promise;
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.setInputMode("vim");

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getVimMode()).toBe("normal");
	});

	it("cancels autocomplete when replacing a Vim draft", async () => {
		const editor = createVimEditor();
		const { promise, resolve } = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "/help", value: "/help" }], prefix: "/" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.onAutocompleteUpdate = resolve;
		typeText(editor, "i/");
		await promise;
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.setText("replacement");

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getVimMode()).toBe("normal");
		expect(editor.getText()).toBe("replacement");
	});

	it("does not retrigger autocomplete after a normal-mode mutation", async () => {
		const editor = createVimEditor();
		const getSuggestions = vi.fn(async () => ({
			items: [{ label: "/help", value: "/help" }],
			prefix: "/",
		}));
		const { promise, resolve } = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			getSuggestions,
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.onAutocompleteUpdate = resolve;
		typeText(editor, "i/he");
		await promise;
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		const callsBeforeMutation = getSuggestions.mock.calls.length;

		editor.handleInput("x");

		expect(getSuggestions).toHaveBeenCalledTimes(callsBeforeMutation);
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getVimMode()).toBe("normal");
	});

	it("retriggers autocomplete after a Vim change enters insert mode", () => {
		const editor = createVimEditor();
		const getSuggestions = vi.fn(async () => ({
			items: [{ label: "/help", value: "/help" }],
			prefix: "/h",
		}));
		editor.setAutocompleteProvider({
			getSuggestions,
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.setText("/he");

		editor.handleInput("C");

		expect(getSuggestions).toHaveBeenCalledTimes(1);
		expect(editor.getVimMode()).toBe("insert");
	});

	it("cancels a pending character jump when enabling Vim mode", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("abcx");
		editor.handleInput("\x1b[H");
		editor.handleInput("\x1d");

		editor.setInputMode("vim");
		editor.handleInput("x");

		expect(editor.getText()).toBe("bcx");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it("cancels a pending character jump when replacing a Vim draft", () => {
		const editor = createVimEditor();
		editor.handleInput("i");
		editor.handleInput("\x1d");

		editor.setText("abcx");
		editor.setInputMode("default");
		editor.handleInput("Q");

		expect(editor.getText()).toBe("abcQx");
	});

	it("cancels an insert-mode character jump when Escape enters normal mode", () => {
		const editor = createVimEditor();
		editor.setText("abxc");
		typeText(editor, "0i");
		editor.handleInput("\x1d");

		editor.handleInput("\x1b");
		editor.handleInput("x");

		expect(editor.getText()).toBe("bxc");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it.each([
		{ pending: "d", key: "w", expected: "one two", cursor: { line: 0, col: 4 } },
		{ pending: "3", key: "x", expected: "ne two", cursor: { line: 0, col: 0 } },
	])("clears pending '$pending' before reserved Ctrl-C", ({ pending, key, expected, cursor }) => {
		const editor = createVimEditor();
		editor.setText("one two");
		editor.handleInput("0");
		editor.handleInput(pending);

		editor.handleInput("\x03");
		editor.handleInput(key);

		expect(editor.getText()).toBe(expected);
		expect(editor.getCursor()).toEqual(cursor);
	});

	it("cleanly switches back to default editing behavior", () => {
		const editor = createVimEditor();
		editor.setText("ab");

		editor.setInputMode("default");
		editor.handleInput("X");

		expect(editor.getVimMode()).toBeUndefined();
		expect(editor.getText()).toBe("aXb");
	});

	it("expands operator ranges over host-owned atomic placeholders", () => {
		const editor = createVimEditor();
		editor.atomicTokenPattern = /\[Image #[^\]]+\]/g;
		editor.setText("[Image #1] rest");

		typeText(editor, "0dw");

		expect(editor.getText()).toBe(" rest");
	});
	it("supports counted D and C across logical lines", () => {
		const deleted = createVimEditor();
		deleted.setText("abc\ndef\nghi");
		typeText(deleted, "ggl2D");
		expect(deleted.getText()).toBe("a\nghi");

		const changed = createVimEditor();
		changed.setText("abc\ndef\nghi");
		typeText(changed, "ggl2C");
		typeText(changed, "X");
		changed.handleInput("\x1b");
		expect(changed.getText()).toBe("aX\nghi");
		changed.handleInput("u");
		expect(changed.getText()).toBe("abc\ndef\nghi");
	});

	it("submits unchanged drafts directly from normal mode", () => {
		const editor = createVimEditor();
		const onSubmit = vi.fn();
		editor.setText("send");
		editor.onSubmit = onSubmit;

		editor.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledWith("send");
		expect(editor.getText()).toBe("");
		expect(editor.getVimMode()).toBe("normal");
	});

	it("does not submit while a visual selection is active", () => {
		const editor = createVimEditor();
		const onSubmit = vi.fn();
		editor.setText("send");
		editor.onSubmit = onSubmit;
		typeText(editor, "0v");

		editor.handleInput("\r");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("send");
		expect(editor.getVimMode()).toBe("visual");
	});

	it("applies autocomplete in insert mode and undoes it with the typed prefix", async () => {
		const editor = createVimEditor();
		const { promise, resolve } = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "/help", value: "/help" }], prefix: "/" };
			},
			applyCompletion() {
				return { lines: ["/help"], cursorLine: 0, cursorCol: 5 };
			},
		});
		editor.onAutocompleteUpdate = resolve;

		typeText(editor, "i/");
		await promise;
		editor.handleInput("\t");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("/help");

		editor.handleInput("u");
		expect(editor.getText()).toBe("");
	});

	it("undoes a forced completion accepted before typing in insert mode", async () => {
		const editor = createVimEditor();
		const { promise, resolve } = Promise.withResolvers<void>();
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return null;
			},
			async getForceFileSuggestions() {
				return { items: [{ label: "file.txt", value: "file.txt" }], prefix: "" };
			},
			applyCompletion() {
				return { lines: ["file.txt"], cursorLine: 0, cursorCol: 8 };
			},
		});
		editor.onAutocompleteUpdate = resolve;
		editor.handleInput("i");
		editor.handleInput("\t");
		await promise;

		editor.handleInput("\t");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("file.txt");
		editor.handleInput("u");
		expect(editor.getText()).toBe("");
	});

	for (const fixture of VIM_TERMINAL_ENVIRONMENTS) {
		it(`preserves Vim text objects, redo, and visual selections under ${fixture.name}`, () => {
			withVimTerminalEnvironment(fixture.env, () => {
				const changedWord = createVimEditor();
				changedWord.setText("one target two");
				typeText(changedWord, "0wllciwreplacement\u001bu\u0012");
				expect(changedWord.getText()).toBe("one replacement two");

				const innerWord = createVimEditor();
				innerWord.setText("one target two");
				typeText(innerWord, "0wlldiw");
				expect(innerWord.getText()).toBe("one  two");

				const aroundWord = createVimEditor();
				aroundWord.setText("one target two");
				typeText(aroundWord, "0wlldaw");
				expect(aroundWord.getText()).toBe("one two");

				const deletedParagraph = createVimEditor();
				deletedParagraph.setText("one\n\ntwo\n\nthree");
				typeText(deletedParagraph, "gg2jdap");
				expect(deletedParagraph.getText()).toBe("one\n\nthree");

				const changedParagraph = createVimEditor();
				changedParagraph.setText("one\n\ntwo\n\nthree");
				typeText(changedParagraph, "gg2jcapreplacement\u001b");
				expect(changedParagraph.getText()).toBe("one\n\nreplacement\nthree");

				const innerParagraph = createVimEditor();
				innerParagraph.setText("one\n\ntwo\nthree\n\nfour");
				typeText(innerParagraph, "gg2jvip");
				const paragraphRender = innerParagraph.render(40).join("\n");
				expect(paragraphRender).toContain("\u001b[7mtwo\u001b[0m");
				expect(paragraphRender).toContain("\u001b[7mthree\u001b[0m");

				const visualLines = createVimEditor();
				visualLines.setText("one\ntwo\nthree");
				typeText(visualLines, "ggVj");
				const visualRender = visualLines.render(40).join("\n");
				expect(visualRender).toContain("\u001b[7mone\u001b[0m");
				expect(visualRender).toContain("\u001b[7mtwo\u001b[0m");
				visualLines.handleInput("d");
				expect(visualLines.getText()).toBe("three");
			});
		});
	}
});
