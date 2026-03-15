import { beforeAll, describe, expect, it, mock } from "bun:test";

type KeybindingsManagerType = typeof import("../src/config/keybindings")["KeybindingsManager"];

let KeybindingsManager: KeybindingsManagerType;

beforeAll(async () => {
	mock.module("@oh-my-pi/pi-tui", () => ({
		CombinedAutocompleteProvider: class CombinedAutocompleteProvider {},
		DEFAULT_EDITOR_KEYBINDINGS: {},
		EditorKeybindingsManager: class EditorKeybindingsManager {},
		getEditorKeybindings: () => new (class EditorKeybindingsManager {})(),
		matchesKey: () => false,
		setEditorKeybindings: () => {},
	}));

	mock.module("@oh-my-pi/pi-utils", () => ({
		getAgentDir: () => "/tmp",
		isEnoent: () => false,
		logger: { warn: () => {} },
	}));

	({ KeybindingsManager } = await import("../src/config/keybindings"));
});

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			dequeue: "alt+up",
		});

		expect(keybindings.getDisplayString("dequeue")).toBe("Alt+Up");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			copyPrompt: ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			copyPrompt: [],
		});

		expect(keybindings.getDisplayString("copyPrompt")).toBe("");
	});
});
