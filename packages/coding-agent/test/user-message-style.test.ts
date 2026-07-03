import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault, getEnumValues, getUi } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const OSC133_ZONE = /\x1b\]133;[AB]\x07/g;

function plain(line: string): string {
	return Bun.stripANSI(line.replace(OSC133_ZONE, ""));
}

describe("display.userMessageStyle", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		settings.clearOverride("display.userMessageStyle");
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("registers the opt-in user-message style setting", () => {
		expect(getDefault("display.userMessageStyle")).toBe("default");
		expect(getEnumValues("display.userMessageStyle")).toEqual(["default", "claude-strip"]);
		expect(getUi("display.userMessageStyle")?.label).toBe("User Message Style");
	});

	it("keeps the existing padded renderer by default", () => {
		const component = new UserMessageComponent("hello there");
		const rendered = component.render(40);
		const textLine = rendered.map(plain).find(line => line.includes("hello there"));

		expect(textLine).toBeDefined();
		expect(textLine?.trim()).toBe("hello there");
		expect(textLine).not.toContain("> hello there");
	});

	it("renders claude-strip prompts as full-width chevron rows", () => {
		settings.override("display.userMessageStyle", "claude-strip");

		const component = new UserMessageComponent("hello there");
		const rendered = component.render(40);
		const row = rendered[0]!;

		expect(rendered).toHaveLength(1);
		expect(plain(row).trimEnd()).toBe("> hello there");
		expect(row).toContain("\x1b[48;");
		expect(visibleWidth(row)).toBe(40);
	});

	it("only prefixes the first wrapped claude-strip row", () => {
		settings.override("display.userMessageStyle", "claude-strip");

		const component = new UserMessageComponent(
			"And then is there any evidence on what they might have used to source this? Is there a public database?",
		);
		const rendered = component.render(50);
		const rows = rendered.map(line => plain(line).trimEnd());

		expect(rendered.length).toBeGreaterThan(1);
		expect(rows[0]?.startsWith("> ")).toBe(true);
		expect(rows.slice(1).every(row => !row.startsWith(">"))).toBe(true);
		expect(rendered.every(row => row.includes("\x1b[48;") && visibleWidth(row) === 50)).toBe(true);
	});
});
