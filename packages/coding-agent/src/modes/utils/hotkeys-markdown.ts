export interface HotkeysMarkdownBindings {
	interruptKey: string;
	clearKey: string;
	exitKey: string;
	suspendKey: string;
	cycleThinkingLevelKey: string;
	cycleModelForwardKey: string;
	cycleModelBackwardKey: string;
	selectModelKey: string;
	planModeKey: string;
	historySearchKey: string;
	expandToolsKey: string;
	toggleTodoExpansionKey: string;
	toggleThinkingKey: string;
	externalEditorKey: string;
	sttKey: string;
	copyLineKey: string;
	copyPromptKey: string;
}

function renderBinding(key: string): string {
	return key || "(unbound)";
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const {
		interruptKey,
		clearKey,
		exitKey,
		suspendKey,
		cycleThinkingLevelKey,
		cycleModelForwardKey,
		cycleModelBackwardKey,
		selectModelKey,
		planModeKey,
		historySearchKey,
		expandToolsKey,
		toggleTodoExpansionKey,
		toggleThinkingKey,
		externalEditorKey,
		sttKey,
		copyLineKey,
		copyPromptKey,
	} = bindings;

	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Arrow keys` | Move cursor / browse history (Up when empty) |",
		"| `Option+Left/Right` | Move by word |",
		"| `Ctrl+A` / `Home` / `Cmd+Left` | Start of line |",
		"| `Ctrl+E` / `End` / `Cmd+Right` | End of line |",
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Enter` | Send message |",
		"| `Shift+Enter` / `Alt+Enter` | New line |",
		"| `Ctrl+W` / `Option+Backspace` | Delete word backwards |",
		"| `Ctrl+U` | Delete to start of line |",
		"| `Ctrl+K` | Delete to end of line |",
		`| \`${renderBinding(copyLineKey)}\` | Copy current line |`,
		`| \`${renderBinding(copyPromptKey)}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Tab` | Path completion / accept autocomplete |",
		`| \`${renderBinding(interruptKey)}\` | Cancel autocomplete / abort streaming |`,
		`| \`${renderBinding(clearKey)}\` | Clear editor (press twice quickly to exit) |`,
		`| \`${renderBinding(exitKey)}\` | Exit (when editor is empty) |`,
		`| \`${renderBinding(suspendKey)}\` | Suspend to background |`,
		`| \`${renderBinding(cycleThinkingLevelKey)}\` | Cycle thinking level |`,
		`| \`${renderBinding(cycleModelForwardKey)}\` | Cycle role models (slow/default/smol) |`,
		`| \`${renderBinding(cycleModelBackwardKey)}\` | Cycle role models (temporary) |`,
		"| `Alt+P` | Select model (temporary) |",
		`| \`${renderBinding(selectModelKey)}\` | Select model (set roles) |`,
		`| \`${renderBinding(planModeKey)}\` | Toggle plan mode |`,
		`| \`${renderBinding(historySearchKey)}\` | Search prompt history |`,
		`| \`${renderBinding(expandToolsKey)}\` | Toggle tool output expansion |`,
		`| \`${renderBinding(toggleTodoExpansionKey)}\` | Toggle todo list expansion |`,
		`| \`${renderBinding(toggleThinkingKey)}\` | Toggle thinking block visibility |`,
		`| \`${renderBinding(externalEditorKey)}\` | Edit message in external editor |`,
		`| \`${renderBinding(sttKey)}\` | Toggle speech-to-text recording |`,
		"| `#` | Open prompt actions |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
