import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
	// SelectList navigation resolves through the keybindings table; pin the
	// arrow/confirm keys so DOWN/UP/Enter work without a global config.
	setKeybindings(
		KeybindingsManager.inMemory({
			"tui.select.cancel": "ctrl+g",
			"tui.select.down": "down",
			"tui.select.up": "up",
			"tui.select.confirm": "enter",
		}),
	);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
	setKeybindings(KeybindingsManager.inMemory());
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		// An absent descriptor (non-TTY test environments) means the property
		// was invented by the stub; delete it so later tests see the original
		// state instead of a leaked 40x120 stub (#8271 review).
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Reflect.deleteProperty(process.stdout, key);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

describe("compaction threshold free-form input (issue #8210)", () => {
	it("offers a Custom… entry and persists a typed value for thresholdPercent", () => {
		const comp = createSelector();
		for (const ch of "compaction threshold") comp.handleInput(ch);
		// The search cursor lands on the last match; walk back up to the
		// "Compaction Threshold" row and open its submenu.
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[A");
		comp.handleInput("\n");

		// Filter the preset list down to the Custom… entry and select it.
		for (const ch of "custom") comp.handleInput(ch);
		comp.handleInput("\n");

		// Type a free-form value and confirm.
		for (const ch of "63") comp.handleInput(ch);
		comp.handleInput("\n");

		expect(settings.get("compaction.thresholdPercent")).toBe(63);
	});

	it("persists a typed value for thresholdTokens", () => {
		const comp = createSelector();
		for (const ch of "compaction threshold") comp.handleInput(ch);
		for (let i = 0; i < 2; i++) comp.handleInput("\x1b[A"); // up to "Compaction Token Limit"
		comp.handleInput("\n");

		// Default + 7 presets precede the Custom… entry (9 rows total, so the
		// list search stays disabled and navigation must walk down).
		for (let i = 0; i < 8; i++) comp.handleInput("\x1b[B");
		comp.handleInput("\n");

		for (const ch of "35000") comp.handleInput(ch);
		comp.handleInput("\n");

		expect(settings.get("compaction.thresholdTokens")).toBe(35_000);
	});

	it("accepts human-formatted input: percent, separators, and K suffix", () => {
		// "65%" → 65 for thresholdPercent.
		let comp = createSelector();
		for (const ch of "compaction threshold") comp.handleInput(ch);
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[A");
		comp.handleInput("\n");
		for (const ch of "custom") comp.handleInput(ch);
		comp.handleInput("\n");
		for (const ch of "65%") comp.handleInput(ch);
		comp.handleInput("\n");
		expect(settings.get("compaction.thresholdPercent")).toBe(65);

		// "160K" → 160000 for thresholdTokens.
		comp = createSelector();
		for (const ch of "compaction threshold") comp.handleInput(ch);
		for (let i = 0; i < 2; i++) comp.handleInput("\x1b[A");
		comp.handleInput("\n");
		for (let i = 0; i < 8; i++) comp.handleInput("\x1b[B");
		comp.handleInput("\n");
		for (const ch of "160K") comp.handleInput(ch);
		comp.handleInput("\n");
		expect(settings.get("compaction.thresholdTokens")).toBe(160_000);
	});

	it("rejects a % suffix on the token-limit field instead of misreading it", () => {
		const comp = createSelector();
		for (const ch of "compaction threshold") comp.handleInput(ch);
		for (let i = 0; i < 2; i++) comp.handleInput("\x1b[A"); // up to "Compaction Token Limit"
		comp.handleInput("\n");
		for (let i = 0; i < 8; i++) comp.handleInput("\x1b[B"); // down to "Custom…"
		comp.handleInput("\n");

		// "65%" would parse as 65 under the percent rule; for a token count the
		// unit is meaningless, so the entry is rejected and nothing is stored.
		for (const ch of "65%") comp.handleInput(ch);
		comp.handleInput("\n");
		expect(settings.get("compaction.thresholdTokens")).toBe(-1);

		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("Expected a number");
	});

	it("routes mouse clicks on preset rows through the threshold submenu", () => {
		const comp = createSelector();
		for (const ch of "compaction threshold") comp.handleInput(ch);
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[A");
		comp.handleInput("\n");

		const lines = comp.render(120);
		const row = lines.findIndex(l => l.includes("10%")) + 1; // SGR rows are 1-based
		expect(row).toBeGreaterThan(0);

		comp.handleInput(`\x1b[<0;3;${row}M`); // left-click on the "10%" preset row

		expect(settings.get("compaction.thresholdPercent")).toBe(10);
	});

	it("rejects out-of-range percent values with an inline error", () => {
		const comp = createSelector();
		for (const ch of "compaction threshold") comp.handleInput(ch);
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[A");
		comp.handleInput("\n");
		for (const ch of "custom") comp.handleInput(ch);
		comp.handleInput("\n");

		// 150 is above the percent max of 100: the error is shown inline and
		// the setting stays at the previous value.
		for (const ch of "150") comp.handleInput(ch);
		comp.handleInput("\n");
		expect(settings.get("compaction.thresholdPercent")).toBe(-1);

		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("Maximum is 100");
	});
});
