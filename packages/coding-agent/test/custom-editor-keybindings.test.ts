import { describe, expect, it, vi } from "bun:test";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { CustomEditor } from "../src/modes/components/custom-editor";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

function createEditor() {
	return new CustomEditor(defaultEditorTheme);
}

describe("CustomEditor literal question mark input", () => {
	it("does not reserve ? as a hotkeys shortcut when the editor is empty", () => {
		const editor = createEditor();

		editor.handleInput("?");

		expect(editor.getText()).toBe("?");
	});
});

describe("CustomEditor Ctrl-D exit behavior", () => {
	it("exits from a completely empty prompt", () => {
		const editor = createEditor();
		const onExit = vi.fn();
		editor.onExit = onExit;

		editor.handleInput(ctrl("d"));

		expect(onExit).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("deletes the character at the cursor instead of exiting when text is present", () => {
		const editor = createEditor();
		const onExit = vi.fn();
		editor.onExit = onExit;
		editor.setText("abc");
		editor.moveToLineStart();

		editor.handleInput(ctrl("d"));

		expect(onExit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("bc");
	});

	it("treats whitespace as non-empty text for Ctrl-D", () => {
		const editor = createEditor();
		const onExit = vi.fn();
		editor.onExit = onExit;
		editor.setText(" ");
		editor.moveToLineStart();

		editor.handleInput(ctrl("d"));

		expect(onExit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});
});

describe("CustomEditor temporary model selector keybinding", () => {
	it("triggers the temporary selector from a remapped action key instead of Alt+P", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;
		editor.setActionKeys("app.model.selectTemporary", ["ctrl+y"]);

		editor.handleInput(ctrl("y"));
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});

	it("removes the default Alt+P shortcut when the action is disabled", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.setActionKeys("app.model.selectTemporary", []);
		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});
});
