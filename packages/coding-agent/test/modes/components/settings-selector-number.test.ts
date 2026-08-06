import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseCouncilConfig } from "@oh-my-pi/pi-coding-agent/council/config";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restore = (key: "rows" | "columns", descriptor: PropertyDescriptor | undefined) => {
		if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		restore() {
			restore("rows", rowsDescriptor);
			restore("columns", columnsDescriptor);
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

describe("numeric settings selector", () => {
	it.each([
		["numeric string", "1"],
		["boolean", true],
		["null", null],
	] as const)("repairs malformed council.rounds stored as %s", (_label, malformedValue) => {
		settings.set("council.rounds", malformedValue as never);
		expect(settings.getRawSetting("council.rounds")).toEqual({ configured: true, value: malformedValue });

		const selector = createSelector();
		for (const character of "review rounds") selector.handleInput(character);
		expect(selector.render(120).join("\n")).toContain("Review Rounds");

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		expect(settings.getRawSetting("council.rounds")).toEqual({ configured: true, value: 2 });
		expect(settings.get("council.rounds")).toBe(2);
		expect(parseCouncilConfig(settings).rounds).toBe(2);
	});
});
