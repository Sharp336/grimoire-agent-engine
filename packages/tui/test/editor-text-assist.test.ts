import { describe, expect, it } from "bun:test";
import { Editor, type EditorTextAssistProvider } from "@oh-my-pi/pi-tui";
import { defaultEditorTheme } from "./test-themes";

describe("Editor text assistance", () => {
	it("shows and accepts word completion without an autocomplete provider", () => {
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		expect(editor.render(40).join("\n")).toContain("er");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("The weather");
	});

	it("applies autocorrection only after the provider returns a boundary replacement", () => {
		const assist: EditorTextAssistProvider = {
			tryAutocorrect: (lines, line, col) =>
				(lines[line] ?? "").slice(0, col).endsWith("teh ") ? { replaceLen: 4, insert: "the " } : null,
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("I typed teh");

		editor.handleInput(" ");

		expect(editor.getText()).toBe("I typed the ");
	});
	it("opens spelling replacements with Ctrl+. and applies the selected word", () => {
		const assist: EditorTextAssistProvider = {
			getWordReplacements: () => ({
				line: 0,
				startCol: 0,
				endCol: 8,
				items: ["received", "relieved"],
			}),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("recieved ");

		editor.handleInput("\x1b[46;5u");

		expect(editor.isAutocompleteActive()).toBeTrue();
		expect(editor.render(40).join("\n")).toContain("received");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("received ");
		expect(editor.getCursor()).toEqual({ line: 0, col: 9 });
	});
});
