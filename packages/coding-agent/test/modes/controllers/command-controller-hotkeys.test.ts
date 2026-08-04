import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-coding-agent/modes/utils/hotkeys-markdown";

describe("buildHotkeysMarkdown", () => {
	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "Alt+Shift+L",
			"app.clipboard.copyPrompt": "Ctrl+Shift+P",
			"app.plan.toggle": "Alt+Shift+P",
			"app.tools.expand": "Ctrl+O",
			"app.tools.toggleVisibility": "Ctrl+Shift+O",
			"app.display.reset": "Alt+L",
			"app.interrupt": "Esc",
			"app.clear": "Ctrl+C",
			"app.exit": "Ctrl+D",
			"app.suspend": "Ctrl+Z",
			"app.thinking.cycle": "Shift+Tab",
			"app.model.cycleForward": "Ctrl+P",
			"app.model.cycleBackward": "Shift+Ctrl+P",
			"app.model.selectTemporary": "Ctrl+Shift+L",
			"app.model.select": "Alt+M",
			"app.history.search": "Ctrl+R",
			"app.thinking.toggle": "Ctrl+T",
			"app.editor.external": "Ctrl+G",
			"app.retry": "Alt+R",
			"app.clipboard.pasteImage": "Ctrl+V",
			"app.stt.toggle": "Alt+H",
			"app.live.toggle": "Ctrl+L",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `Ctrl+Shift+P` | Copy whole prompt |");
		expect(markdown).toContain("| `Ctrl+Shift+L` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
		expect(markdown).toContain("| `Alt+L` | Reset terminal display |");
		expect(markdown).toContain("| `Ctrl+L` | Start/stop live voice mode (/live) |");
		expect(markdown).toContain("| `Alt+R` | Retry last failed assistant turn |");
		expect(markdown).toContain("| `Alt+Shift+P` | Toggle plan mode |");
		expect(markdown).toContain("| `Ctrl+Shift+O` | Toggle tool activity visibility |");
		expect(markdown).toContain("| `#<number>` | GitHub issue/PR reference");
		expect(markdown).toContain("| `#` / `#<text>` | Prompt actions");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Alt+M";
					}
					if (action === "app.display.reset") {
						return "Alt+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Disabled` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
	});
});

describe("buildHotkeysMarkdown static editor chords", () => {
	const keybindings = { getDisplayString: () => "Ctrl+K" };

	it("labels the static chords with the Apple key glyphs on darwin", () => {
		const markdown = buildHotkeysMarkdown({ keybindings, platform: "darwin" });

		expect(markdown).toContain("| `⌥+Left` / `⌥+Right` | Move by word |");
		expect(markdown).toContain("| `Shift+Enter` / `⌥+Enter` | New line |");
		expect(markdown).toContain("| `Ctrl+W` / `⌥+Backspace` | Delete word backwards |");
		expect(markdown).toContain("| `Ctrl+A` / `Home` / `⌘+Left` | Start of line |");
		expect(markdown).toContain("| `Ctrl+E` / `End` / `⌘+Right` | End of line |");
		// Nothing may fall back to the ASCII names once the host is macOS.
		for (const ascii of ["Alt+", "Cmd+", "Super+", "Option+"]) {
			expect(markdown).not.toContain(ascii);
		}
	});

	it("uses the ASCII modifier names off darwin and drops the mac-only chords", () => {
		const markdown = buildHotkeysMarkdown({ keybindings, platform: "linux" });

		expect(markdown).toContain("| `Alt+Left` / `Alt+Right` | Move by word |");
		expect(markdown).toContain("| `Shift+Enter` / `Alt+Enter` | New line |");
		expect(markdown).toContain("| `Ctrl+W` / `Alt+Backspace` | Delete word backwards |");
		// `super+left` / `super+right` are not bound anywhere; the rows only ever
		// described the macOS editing convention, so they stay off other hosts
		// instead of being relabelled into a chord that does nothing.
		expect(markdown).toContain("| `Ctrl+A` / `Home` | Start of line |");
		expect(markdown).toContain("| `Ctrl+E` / `End` | End of line |");
		for (const macOnly of ["⌥", "⌘", "Cmd+", "Option+"]) {
			expect(markdown).not.toContain(macOnly);
		}
	});

	// `command-controller.ts` calls `buildHotkeysMarkdown({ keybindings })` with no
	// `platform`, so the `?? process.platform` fallback is the only path `/hotkeys`
	// ever takes in production.
	describe("without an injected platform", () => {
		let platformDescriptor: PropertyDescriptor;

		beforeEach(() => {
			platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		});

		afterEach(() => {
			Object.defineProperty(process, "platform", platformDescriptor);
		});

		it("follows the host platform", () => {
			Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
			expect(buildHotkeysMarkdown({ keybindings })).toContain("| `⌥+Left` / `⌥+Right` | Move by word |");

			Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
			const linux = buildHotkeysMarkdown({ keybindings });
			expect(linux).toContain("| `Alt+Left` / `Alt+Right` | Move by word |");
			expect(linux).toContain("| `Ctrl+A` / `Home` | Start of line |");
		});
	});
});
