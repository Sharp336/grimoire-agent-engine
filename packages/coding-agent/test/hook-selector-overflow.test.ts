import { beforeAll, describe, expect, it } from "bun:test";
import {
	computeOutlinePickerLayout,
	HookSelectorComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
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

	it("grows the detail pane to fit the focused option without truncation when viewport budget allows", () => {
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
				maxDetailRows: 20, // generous viewport budget so the option fits in full
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

		// Focused on long option: detail pane appears, bounded by maxDetailRows.
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

	it("truncates with an ellipsis when the focused option exceeds the viewport budget", () => {
		// 80-cols of unbreakable text repeated → wraps to many rows; viewport budget forces overflow.
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

	it.each([
		// [terminalRows, expect pane on/off]
		[24, true],
		[30, true],
		[40, true],
		[60, true],
		[80, true],
		// Below the joint-min threshold (MIN_LIST_ROWS + MIN_DETAIL_PANE_ROWS + PICKER_CHROME_ROWS),
		// the helper disables the pane rather than overflow. We don't assert
		// "fits in N rows" below 16 rows — the legacy non-outline path also
		// floors maxVisible at 4 and overflows tiny terminals (pre-existing).
		[16, false],
	])("renders within %i terminal rows when focused on the worst-case option", (terminalRows, paneExpected) => {
		const layout = computeOutlinePickerLayout(terminalRows);
		if (paneExpected) {
			expect(layout.maxDetailRows).toBeGreaterThan(0);
		} else {
			expect(layout.maxDetailRows).toBe(0);
		}

		const width = 80;
		const detailWidth = Math.max(1, width - 4); // matches OutlinedList: borders + 1-col inset each side
		// Worst-case focused option: wraps to exactly `maxDetailRows` lines so the
		// pane uses its full reservation. Use 'X' so wrapTextWithAnsi can't split
		// on whitespace and pads each row toward `detailWidth`.
		const worstCaseRows = Math.max(layout.maxDetailRows, 1);
		const worstCase = "X".repeat(detailWidth * worstCaseRows);
		const options: string[] = [];
		// Fill list with enough options to exercise the maxVisible cap.
		for (let i = 0; i < layout.maxVisible + 2; i++) options.push(`Short option ${i}`);
		const worstIndex = options.length;
		options.push(worstCase);

		const component = new HookSelectorComponent(
			"Title",
			options,
			() => {},
			() => {},
			{
				outline: true,
				initialIndex: worstIndex,
				maxVisible: layout.maxVisible,
				maxDetailRows: layout.maxDetailRows,
			},
		);
		const lines = component.render(width);
		// The whole picker — chrome + list + (separator + detail if any) — must
		// fit within the terminal so the controls hint and bottom border survive.
		expect(lines.length).toBeLessThanOrEqual(terminalRows);
	});

	it("lets the detail budget grow beyond the previous fixed twenty-row ceiling on tall terminals", () => {
		const terminalRows = 80;
		const layout = computeOutlinePickerLayout(terminalRows);
		expect(layout.maxDetailRows).toBeGreaterThan(20);
		expect(layout.maxVisible + layout.maxDetailRows).toBe(terminalRows - 12);
		expect(layout.maxVisible).toBeGreaterThanOrEqual(4);
	});

	it("reproduces the reviewer's 24-row scenario without overflowing", () => {
		// Pre-fix: maxDetailRows=12, maxVisible floored at 4 → ~28 rows on a 24-row terminal.
		// Post-fix: joint sizing keeps the worst-case total <= 24.
		const layout = computeOutlinePickerLayout(24);
		expect(layout.maxVisible + layout.maxDetailRows).toBeLessThanOrEqual(12);
	});
});
