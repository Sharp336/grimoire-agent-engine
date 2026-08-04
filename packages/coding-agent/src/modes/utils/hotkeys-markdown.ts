import { type AppKeybinding, formatKeyHint, type KeybindingsManager, type KeyId } from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString">;
	/** Host platform deciding the modifier labels; defaults to the running host. */
	platform?: NodeJS.Platform;
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const platform = bindings.platform ?? process.platform;
	const appKey = (action: AppKeybinding) => bindings.keybindings.getDisplayString(action, platform) || "Disabled";
	const key = (id: KeyId) => formatKeyHint(id, platform);
	// `super+left` / `super+right` are not bound; these rows document the macOS
	// editing convention the terminal itself provides, so they are omitted rather
	// than relabelled into a chord that does nothing on other hosts.
	const lineStart = platform === "darwin" ? `\`Ctrl+A\` / \`Home\` / \`${key("super+left")}\`` : "`Ctrl+A` / `Home`";
	const lineEnd = platform === "darwin" ? `\`Ctrl+E\` / \`End\` / \`${key("super+right")}\`` : "`Ctrl+E` / `End`";
	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Arrow keys` | Move cursor / browse history (Up when empty) |",
		`| \`${key("alt+left")}\` / \`${key("alt+right")}\` | Move by word |`,
		`| ${lineStart} | Start of line |`,
		`| ${lineEnd} | End of line |`,
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Enter` | Send message |",
		`| \`Shift+Enter\` / \`${key("alt+enter")}\` | New line |`,
		`| \`Ctrl+W\` / \`${key("alt+backspace")}\` | Delete word backwards |`,
		"| `Ctrl+U` | Delete to start of line |",
		"| `Ctrl+K` | Delete to end of line |",
		`| \`${appKey("app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${appKey("app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Tab` | Path completion / accept autocomplete |",
		`| \`${appKey("app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${appKey("app.clear")}\` | Clear editor (first) / exit (second) |`,
		`| \`${appKey("app.exit")}\` | Exit (when editor is empty) |`,
		`| \`${appKey("app.suspend")}\` | Suspend to background |`,
		`| \`${appKey("app.display.reset")}\` | Reset terminal display |`,
		`| \`${appKey("app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${appKey("app.model.cycleForward")}\` | Cycle role models (slow/default/smol) |`,
		`| \`${appKey("app.model.cycleBackward")}\` | Cycle role models (backward) |`,
		`| \`${appKey("app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${appKey("app.model.select")}\` | Select model (set roles) |`,
		`| \`${appKey("app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${appKey("app.history.search")}\` | Search prompt history |`,
		`| \`${appKey("app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${appKey("app.tools.toggleVisibility")}\` | Toggle tool activity visibility |`,
		`| \`${appKey("app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${appKey("app.editor.external")}\` | Edit message in external editor |`,
		`| \`${appKey("app.retry")}\` | Retry last failed assistant turn |`,
		`| \`${appKey("app.clipboard.pasteImage")}\` | Paste image or text from clipboard |`,
		"| Hold `Space` | Speech-to-text (push-to-talk): hold to record, release to transcribe |",
		`| \`${appKey("app.live.toggle")}\` | Start/stop live voice mode (/live) |`,
		`| \`${appKey("app.agents.hub")}\` / \`${appKey("app.session.observe")}\` / double-tap \`←\` (empty editor) | Open the agent hub |`,
		"| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |",
		"| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
