import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getDefaultPasteImageKeys,
	KeybindingsManager,
	withMacCommand,
} from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { keyText } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.dequeue": "alt+up",
		});

		expect(keybindings.getDisplayString("app.message.dequeue")).toBe("Alt+Up");
	});

	it("defaults retry to Alt+R", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getDisplayString("app.retry")).toBe("Alt+R");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});
});

describe("legacy keyText", () => {
	let previous: TuiKeybindingsManager;

	beforeEach(() => {
		previous = getKeybindings();
	});

	afterEach(() => {
		setKeybindings(previous);
	});

	it("formats the active binding for legacy extensions", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));

		expect(keyText("app.tools.expand")).toBe("Alt+E");
	});
});

describe("getDefaultPasteImageKeys", () => {
	it("keeps Ctrl+V registered for image paste on Windows alongside the terminal-safe fallback", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
	});

	it("adds the macOS Command key event to Ctrl+V for image paste", () => {
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
	});
});

describe("withMacCommand", () => {
	it("appends the Command chord only on darwin", () => {
		expect(withMacCommand(["alt+up"], "super+up", "darwin")).toEqual(["alt+up", "super+up"]);
		expect(withMacCommand(["alt+up"], "super+up", "linux")).toEqual(["alt+up"]);
		expect(withMacCommand(["alt+up"], "super+up", "win32")).toEqual(["alt+up"]);
	});

	it("leaves retry, selectTemporary and agents.hub Option-only so they cannot shadow a mirrored ctrl chord", () => {
		const keybindings = KeybindingsManager.inMemory();
		for (const action of ["app.retry", "app.model.selectTemporary", "app.agents.hub"] as const) {
			expect(keybindings.getKeys(action).some(key => key.startsWith("super+"))).toBe(false);
		}
	});
});
