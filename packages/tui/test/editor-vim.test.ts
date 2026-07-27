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

	it("undoes an insert session as one change", () => {
		const editor = createVimEditor();

		editor.handleInput("i");
		typeText(editor, "hello world");
		editor.handleInput("\x1b");
		editor.handleInput("u");

		expect(editor.getText()).toBe("");
	});
	it("redoes an undone change with Ctrl-R in normal mode", () => {
		const editor = createVimEditor();

		typeText(editor, "ihello world\u001bu");
		expect(editor.getText()).toBe("");

		editor.handleInput("\u0012");
		expect(editor.getText()).toBe("hello world");
		expect(editor.getVimMode()).toBe("normal");
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
