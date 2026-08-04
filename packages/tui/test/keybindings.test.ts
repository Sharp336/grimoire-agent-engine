import { describe, expect, it } from "bun:test";
import {
	addKeyAliases,
	canonicalKeyId,
	KeybindingsManager,
	type KeyId,
	matchesKey,
	parseKey,
	TUI_KEYBINDINGS,
} from "@oh-my-pi/pi-tui";

describe("KeybindingsManager", () => {
	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		expect(keybindings.getKeys("tui.input.submit")).toEqual(["enter", "ctrl+enter"]);
		expect(keybindings.getKeys("tui.select.confirm")).toEqual(["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		expect(keybindings.getKeys("tui.select.up")).toEqual(["up", "ctrl+p"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["up"]);
	});

	it("preserves Shift when matching printable uppercase letters", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "shift+a",
		});

		expect(keybindings.matches("A", "tui.input.copy")).toBe(true);
		expect(keybindings.matches("a", "tui.input.copy")).toBe(false);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		expect(keybindings.getConflicts()).toEqual([
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		expect(keybindings.getKeys("tui.editor.cursorLeft")).toEqual(["left", "ctrl+b"]);
	});

	it("ships ctrl+j alongside shift+enter as default newline keys", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		const newLineKeys = keybindings.getKeys("tui.input.newLine");
		expect(newLineKeys).toContain("ctrl+j");
		expect(newLineKeys).toContain("shift+enter");
	});

	it("exports the canonical alias helpers used by matching", () => {
		const aliases = new Set<string>();
		for (const key of ["esc", "return", "?", "shift+a"] as const) {
			addKeyAliases(aliases, key);
		}

		expect([...aliases].sort()).toEqual(["?", "enter", "escape", "shift+?", "shift+a"]);
		expect(canonicalKeyId("A")).toBe("shift+a");
		expect(canonicalKeyId("shift+?")).toBe("shift+?");

		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": ["esc", "return", "?", "shift+a"],
		});

		for (const input of ["\x1b", "\r", "?", "A"]) {
			const parsed = parseKey(input);
			if (parsed === undefined) throw new Error(`Expected ${JSON.stringify(input)} to parse`);
			expect(aliases.has(canonicalKeyId(parsed))).toBe(true);
			expect(keybindings.matches(input, "tui.input.copy")).toBe(true);
		}
	});
});

describe("canonicalKeyId macOS modifier spellings", () => {
	it("folds the Option and Command spellings onto the canonical modifiers", () => {
		for (const spelling of ["Option+p", "option+p", "⌥+p"]) {
			expect(canonicalKeyId(spelling)).toBe("alt+p");
		}
		for (const spelling of ["Command+p", "command+p", "Cmd+p", "cmd+p", "⌘+p"]) {
			expect(canonicalKeyId(spelling)).toBe("super+p");
		}
	});

	it("keeps the canonical ASCII spellings and modifier ordering intact", () => {
		expect(canonicalKeyId("alt+p")).toBe("alt+p");
		expect(canonicalKeyId("super+v")).toBe("super+v");
		expect(canonicalKeyId("alt+ctrl+x")).toBe("ctrl+alt+x");
		expect(canonicalKeyId("⌥+shift+l")).toBe("shift+alt+l");
	});

	it("still promotes an uppercase base letter to Shift behind the new spellings", () => {
		// Terminal input rule: a bare uppercase letter carries Shift (see the
		// `canonicalKeyId("A") === "shift+a"` case above). Config-authored chords
		// are lowercased by `normalizeKeys` before they reach here, so `⌥+P` in
		// `keybindings.yml` still resolves to `alt+p`.
		expect(canonicalKeyId("⌥+P")).toBe("shift+alt+p");
		expect(canonicalKeyId("⌘+V")).toBe("shift+super+v");
	});

	it("collapses a modifier spelled twice instead of emitting a dead chord", () => {
		expect(canonicalKeyId("alt+option+p")).toBe("alt+p");
		expect(canonicalKeyId("cmd+⌘+v")).toBe("super+v");
	});

	it("matches glyph spellings exactly rather than case-folding them", () => {
		// ⌅ (U+2305) and ⋸ (U+22F8) are ⌥ (U+2325) and ⌘ (U+2318) minus the ASCII
		// case-fold delta; only ASCII letters may fold, so these stay base keys.
		expect(canonicalKeyId("⌅+p")).toBe("⌅+p");
		expect(canonicalKeyId("⋸+v")).toBe("⋸+v");
	});

	it("resolves a binding authored with the macOS spelling against the real key event", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			// `KeyId` only spells the canonical chords; the macOS spellings are an
			// input tolerance for hand-written `keybindings.yml`, which reaches the
			// manager as an unvalidated YAML string rather than through this type.
			"tui.input.copy": "Option+P" as KeyId,
		});

		expect(keybindings.matches("\x1bp", "tui.input.copy")).toBe(true);
	});

	it("reports a conflict when two actions claim one chord under different spellings", () => {
		// Both resolve to `alt+x` at match time, so the second binding silently
		// shadows the first unless conflict detection canonicalizes as well.
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "alt+x" as KeyId,
			"tui.select.confirm": "Option+x" as KeyId,
		});

		expect(keybindings.getConflicts()).toEqual([
			{
				key: "alt+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
	});

	it("reports a conflict when two actions claim one chord in different modifier orders", () => {
		// Same canonicalization, different defect: folding only the spelling and
		// leaving the authored order intact would pass the test above and fail here.
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "alt+ctrl+x" as KeyId,
			"tui.select.confirm": "ctrl+alt+x" as KeyId,
		});

		expect(keybindings.getConflicts()).toEqual([
			{
				key: "ctrl+alt+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
	});
});

describe("getKeys output is safe for the native matcher", () => {
	// Components match `getKeys()` output directly with `matchesKey`, which routes to
	// the Rust `parse_key_id`. That parser knows only ctrl/shift/super/alt and
	// consumes an unrecognized part as the key token, so an unfolded `⌥+a` degrades
	// to the bare `a` — plain letters would start firing chorded actions.
	it("folds alias spellings so a chord never degrades to its bare base key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "⌥+a" as KeyId,
			"tui.editor.yankPop": "Cmd+O" as KeyId,
			"tui.editor.undo": "Option+l" as KeyId,
		});

		expect(keybindings.getKeys("tui.input.copy")).toEqual(["alt+a"]);
		expect(keybindings.getKeys("tui.editor.yankPop")).toEqual(["super+o"]);
		expect(keybindings.getKeys("tui.editor.undo")).toEqual(["alt+l"]);

		for (const [key, bare, chord] of [
			[keybindings.getKeys("tui.input.copy")[0], "a", "\x1ba"],
			[keybindings.getKeys("tui.editor.undo")[0], "l", "\x1bl"],
		] as const) {
			expect(matchesKey(bare, key as KeyId)).toBe(false);
			expect(matchesKey(chord, key as KeyId)).toBe(true);
		}
	});

	it("preserves the authored modifier order while folding the spelling", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "alt+shift+p" as KeyId,
			"tui.editor.undo": "⌥+shift+p" as KeyId,
		});

		// Order is display-relevant (`Alt+Shift+P` is the documented default), so
		// folding must not reorder the way `canonicalKeyId` does.
		expect(keybindings.getKeys("tui.input.copy")).toEqual(["alt+shift+p"]);
		expect(keybindings.getKeys("tui.editor.undo")).toEqual(["alt+shift+p"]);
	});

	it("folds an alias that is not the leading modifier", () => {
		// Guards the split point: normalizing around the FIRST `+` would leave every
		// modifier after it unfolded, and each case here has the alias in second
		// position where the leading-alias cases above cannot catch it.
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "shift+⌥+p" as KeyId,
			"tui.editor.undo": "ctrl+option+m" as KeyId,
			"tui.editor.yankPop": "shift+cmd+o" as KeyId,
		});

		expect(keybindings.getKeys("tui.input.copy")).toEqual(["shift+alt+p"]);
		expect(keybindings.getKeys("tui.editor.undo")).toEqual(["ctrl+alt+m"]);
		expect(keybindings.getKeys("tui.editor.yankPop")).toEqual(["shift+super+o"]);
	});

	it("leaves a chord whose base key is itself a plus sign intact", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "ctrl++" as KeyId,
		});

		expect(keybindings.getKeys("tui.input.copy")).toEqual(["ctrl++"]);
	});

	it("treats Object.prototype member names as ordinary key parts", () => {
		// The spelling table is an object literal, so a bare `MODIFIER_SPELLINGS[part]`
		// resolves `constructor`/`toString` through the prototype chain — and `??`
		// does not catch it, corrupting the chord into native-code text.
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "constructor+p" as KeyId,
			"tui.editor.undo": "ctrl+toString+p" as KeyId,
		});

		expect(keybindings.getKeys("tui.input.copy")).toEqual(["constructor+p" as KeyId]);
		expect(keybindings.getKeys("tui.editor.undo")).toEqual(["ctrl+tostring+p" as KeyId]);
	});

	it("leaves an unmodified base key untouched", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "Enter" as KeyId,
		});

		expect(keybindings.getKeys("tui.input.copy")).toEqual(["enter"]);
	});
});
