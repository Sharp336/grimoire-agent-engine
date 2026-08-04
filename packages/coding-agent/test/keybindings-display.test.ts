import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatKeyHints,
	getDefaultPasteImageKeys,
	KeybindingsManager,
	type KeyId,
	modifierLabel,
} from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { keyText } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.dequeue": "alt+up",
		});

		expect(keybindings.getDisplayString("app.message.dequeue", "linux")).toBe("Alt+Up");
	});

	it("defaults retry to Alt+R", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getDisplayString("app.retry", "linux")).toBe("Alt+R");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt", "linux")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt", "linux")).toBe("");
	});
});

describe("macOS modifier labels", () => {
	it("renders Alt and Super with the glyphs printed on the Apple keys", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.model.selectTemporary": "alt+p",
			"app.clipboard.pasteImage": "super+v",
			"app.clipboard.copyLine": "alt+shift+l",
		});

		expect(keybindings.getDisplayString("app.model.selectTemporary", "darwin")).toBe("⌥+P");
		expect(keybindings.getDisplayString("app.clipboard.pasteImage", "darwin")).toBe("⌘+V");
		expect(keybindings.getDisplayString("app.clipboard.copyLine", "darwin")).toBe("⌥+Shift+L");
	});

	it("keeps the ASCII modifier names on every other platform", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.model.selectTemporary": "alt+p",
			"app.clipboard.pasteImage": "super+v",
		});

		for (const platform of ["linux", "win32"] as const) {
			expect(keybindings.getDisplayString("app.model.selectTemporary", platform)).toBe("Alt+P");
			expect(keybindings.getDisplayString("app.clipboard.pasteImage", platform)).toBe("Super+V");
		}
	});

	it("preserves the authored modifier order instead of reordering the chord", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.plan.toggle": "alt+shift+p",
		});

		expect(keybindings.getDisplayString("app.plan.toggle", "linux")).toBe("Alt+Shift+P");
		expect(keybindings.getDisplayString("app.plan.toggle", "darwin")).toBe("⌥+Shift+P");
	});

	it("formats standalone key hints for the requested platform", () => {
		expect(formatKeyHints(["alt+up", "shift+up"], "darwin")).toBe("⌥+Up/Shift+Up");
		expect(formatKeyHints(["alt+up", "shift+up"], "linux")).toBe("Alt+Up/Shift+Up");
		expect(formatKeyHints("ctrl+alt+]", "darwin")).toBe("Ctrl+⌥+]");
	});

	it("exposes the bare modifier label for compact multi-key hints", () => {
		expect(modifierLabel("alt", "darwin")).toBe("⌥");
		expect(modifierLabel("alt", "linux")).toBe("Alt");
		expect(modifierLabel("option", "darwin")).toBe("⌥");
		expect(modifierLabel("super", "darwin")).toBe("⌘");
		expect(modifierLabel("super", "linux")).toBe("Super");
		expect(modifierLabel("ctrl", "darwin")).toBe("Ctrl");
	});

	it("treats Object.prototype member names as ordinary key parts", () => {
		// The label and spelling tables are object literals, so an unguarded lookup
		// resolves `constructor`/`toString` through the prototype chain and renders
		// the native-code text of a function.
		expect(formatKeyHints("ctrl+constructor" as KeyId, "darwin")).toBe("Ctrl+Constructor");
		expect(modifierLabel("constructor", "darwin")).toBe("constructor");
		expect(modifierLabel("toString", "linux")).toBe("toString");
	});
});

describe("keybindings.yml authored with the macOS spellings", () => {
	let previous: TuiKeybindingsManager;
	let agentDir: string;

	beforeEach(() => {
		previous = getKeybindings();
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-keybindings-"));
	});

	afterEach(() => {
		setKeybindings(previous);
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("loads Option/⌥/Cmd chords off disk, matches them, and relabels per platform", () => {
		// The loader parses `keybindings.yml` as plain YAML with no schema, so these
		// spellings reach the manager verbatim; only `canonicalKeyId` folds them.
		fs.writeFileSync(
			path.join(agentDir, "keybindings.yml"),
			["app.model.selectTemporary: Option+j", "app.retry: ⌥+k", "app.clipboard.pasteImage: Cmd+v", ""].join("\n"),
			"utf-8",
		);

		const keybindings = KeybindingsManager.create(agentDir, { inheritedAgentDir: agentDir });

		expect(keybindings.matches("\x1bj", "app.model.selectTemporary")).toBe(true);
		expect(keybindings.matches("\x1bk", "app.retry")).toBe(true);
		expect(keybindings.getDisplayString("app.model.selectTemporary", "darwin")).toBe("⌥+J");
		expect(keybindings.getDisplayString("app.retry", "linux")).toBe("Alt+K");
		expect(keybindings.getDisplayString("app.clipboard.pasteImage", "darwin")).toBe("⌘+V");
		expect(keybindings.getDisplayString("app.clipboard.pasteImage", "linux")).toBe("Super+V");
		// Round-trip contract: the modifier is folded to its canonical name while the
		// authored order is kept. `getKeys()` output is handed to the native matcher
		// and `/keybindings` writes it back to disk, so the alias must not survive.
		expect(keybindings.getKeys("app.model.selectTemporary")).toEqual(["alt+j"]);
		expect(keybindings.getEffectiveConfig()["app.retry"]).toBe("alt+k");
		expect(keybindings.getKeys("app.clipboard.pasteImage")).toEqual(["super+v"]);
	});
});

describe("legacy keyText", () => {
	let previous: TuiKeybindingsManager;
	let platformDescriptor: PropertyDescriptor;

	beforeEach(() => {
		previous = getKeybindings();
		platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	});

	afterEach(() => {
		setKeybindings(previous);
		Object.defineProperty(process, "platform", platformDescriptor);
	});

	it("formats the active binding for legacy extensions", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));

		expect(keyText("app.tools.expand")).toBe("Alt+E");
	});

	it("follows the host platform when no platform is supplied", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));

		expect(keyText("app.tools.expand")).toBe("⌥+E");
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
