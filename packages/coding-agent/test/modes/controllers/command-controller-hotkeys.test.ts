import { describe, expect, it } from "bun:test";
import { buildHotkeysMarkdown, type HotkeysMarkdownBindings } from "../../../src/modes/utils/hotkeys-markdown";

function createBindings(overrides: Partial<HotkeysMarkdownBindings> = {}): HotkeysMarkdownBindings {
	return {
		interruptKey: "Esc",
		clearKey: "Ctrl+C",
		exitKey: "Ctrl+D",
		suspendKey: "Ctrl+Z",
		cycleThinkingLevelKey: "Shift+Tab",
		cycleModelForwardKey: "Ctrl+P",
		cycleModelBackwardKey: "Ctrl+Shift+P",
		selectModelKey: "Ctrl+L",
		planModeKey: "Alt+M",
		historySearchKey: "Ctrl+R",
		expandToolsKey: "Ctrl+O",
		toggleTodoExpansionKey: "Ctrl+T",
		toggleThinkingKey: "",
		externalEditorKey: "Ctrl+G",
		sttKey: "Alt+H",
		copyLineKey: "Alt+Shift+L",
		copyPromptKey: "Alt+Shift+C",
		...overrides,
	};
}

describe("buildHotkeysMarkdown", () => {
	it("emits flush-left markdown so headings and tables are parsed instead of treated as indented text", () => {
		const markdown = buildHotkeysMarkdown(createBindings());

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `Alt+Shift+C` | Copy whole prompt |");
		expect(markdown).toContain("| `Alt+M` | Toggle plan mode |");
		expect(markdown).toContain("| `#` | Open prompt actions |");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("renders remapped and unbound app actions truthfully in /hotkeys markdown", () => {
		const markdown = buildHotkeysMarkdown(
			createBindings({
				externalEditorKey: "Ctrl+X",
				toggleThinkingKey: "",
			}),
		);

		expect(markdown).toContain("| `Ctrl+T` | Toggle todo list expansion |");
		expect(markdown).toContain("| `(unbound)` | Toggle thinking block visibility |");
		expect(markdown).toContain("| `Ctrl+X` | Edit message in external editor |");
		expect(markdown).not.toContain("| `Ctrl+G` | Edit message in external editor |");
	});
});
