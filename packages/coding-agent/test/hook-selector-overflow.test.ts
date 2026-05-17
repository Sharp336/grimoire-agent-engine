import { beforeAll, describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});

// A full-width horizontal line is the OutlinedList border (─ repeated to width).
// The hook selector also draws a DynamicBorder top + bottom which match.
function countHorizontals(lines: string[], width: number): number {
	const target = "─".repeat(width);
	let n = 0;
	for (const line of lines) {
		if (Bun.stripANSI(line) === target) n++;
	}
	return n;
}

describe("HookSelectorComponent", () => {
	it("keeps outlined options within render width when no detail pane is active", () => {
		const options = [
			"aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;b",
			"bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;aaa;bbb;a",
			"a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b;a;b",
		];
		const component = new HookSelectorComponent(
			"Which pattern do you prefer?",
			options,
			() => {},
			() => {},
			{ outline: true, initialIndex: 0 },
		);

		const width = 80;
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
		// Without maxDetailRows the OutlinedList only draws top + bottom horizontals;
		// combined with the outer DynamicBorders that totals 4 full-width rows.
		expect(countHorizontals(lines, width)).toBe(4);
	});

	it("grows the detail pane to fit the focused option without truncation when cap allows", () => {
		const longOption =
			"Very long option: This option is intentionally oversized to exercise wrapping, overflow handling, selection rendering, and any truncation behavior in the ask tool UI. It should be long enough to span multiple terminal columns and potentially multiple lines so the recent changes are visible under realistic stress conditions.";
		const options = ["Short proceed (Recommended)", longOption, "Other (type your own)"];
		const width = 120;
		const component = new HookSelectorComponent(
			"Pick one",
			options,
			() => {},
			() => {},
			{
				outline: true,
				initialIndex: 1,
				maxDetailRows: 20, // generous cap so the option fits in full
			},
		);
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
		// 5 full-width horizontals: outer DynamicBorder × 2 + OutlinedList top + separator + bottom.
		expect(countHorizontals(lines, width)).toBe(5);
		const allText = lines.map(line => Bun.stripANSI(line)).join("\n");
		// Last words of the option must be visible — no trailing ellipsis cutoff.
		expect(allText).toContain("realistic stress conditions.");
		expect(allText).not.toMatch(/stress c…/);
	});

	it("shrinks the detail pane when the focused option fits in fewer rows than the cap", () => {
		const shortOption = "Short proceed";
		const longOption = `Very long option: ${"wrap-payload ".repeat(40)}tail-marker`; // wraps well past any small cap
		const options = [shortOption, longOption];
		const width = 80;
		const maxDetailRows = 8;

		// Focused on short option: detail wraps to a single line → skip the pane entirely.
		const focusedShort = new HookSelectorComponent(
			"Q",
			options,
			() => {},
			() => {},
			{
				outline: true,
				initialIndex: 0,
				maxDetailRows,
			},
		);
		const linesShort = focusedShort.render(width);
		// Only outer DynamicBorders + OutlinedList top/bottom = 4 horizontals when pane is hidden.
		expect(countHorizontals(linesShort, width)).toBe(4);

		// Focused on long option: detail pane appears, capped at maxDetailRows.
		const focusedLong = new HookSelectorComponent(
			"Q",
			options,
			() => {},
			() => {},
			{
				outline: true,
				initialIndex: 1,
				maxDetailRows,
			},
		);
		const linesLong = focusedLong.render(width);
		expect(countHorizontals(linesLong, width)).toBe(5);
		// Pane fired and grew vertically vs. the short-focus render.
		expect(linesLong.length).toBeGreaterThan(linesShort.length);
		for (const line of linesLong) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("truncates with an ellipsis when the focused option exceeds the cap", () => {
		// 80-cols of unbreakable text repeated → wraps to many rows; cap forces overflow.
		const overflowing = "longword".repeat(40); // 320 chars, no spaces
		const options = [overflowing];
		const component = new HookSelectorComponent(
			"Q",
			options,
			() => {},
			() => {},
			{
				outline: true,
				initialIndex: 0,
				maxDetailRows: 2,
			},
		);
		const width = 80;
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
		const allText = lines.map(line => Bun.stripANSI(line)).join("\n");
		expect(allText).toContain("…");
	});
});
