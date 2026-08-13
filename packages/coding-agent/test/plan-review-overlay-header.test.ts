/**
 * `PlanReviewOverlayOptions.header` renders caller-supplied, pre-sanitized rows
 * full-width above the plan body. The interesting behaviour is geometric: the
 * header costs its rows plus the rule that closes it, and because `regionRows`
 * clamps upward through `Math.max(MIN_BODY_ROWS, …)` a short terminal cannot
 * shed those rows implicitly. The overlay therefore tries the full block, falls
 * back to `headerCollapsed` (the header's first row unless the caller supplies
 * one), and only drops the header whole when even that would squeeze the plan
 * body below the minimum. In the sidebar layout the header spans both columns,
 * so the split has to be opened by the header's closing rule
 * (`dividerSplitOpen`) rather than by the top border.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { dividerSplit, dividerSplitOpen } from "@oh-my-pi/pi-coding-agent/modes/components/overlay-box";
import { PlanReviewOverlay } from "@oh-my-pi/pi-coding-agent/modes/components/plan-review-overlay";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings, visibleWidth } from "@oh-my-pi/pi-tui";

/** Mirrors the overlay's private `MIN_BODY_ROWS`. */
const MIN_BODY_ROWS = 3;
const WIDTH = 80;
const HEADER = ["HDR-ALPHA", "HDR-BETA", "HDR-GAMMA"] as const;
const OPTIONS = ["Approve and execute", "Approve and keep context", "Refine plan"];
const PROMPT = "Plan mode - next step";

/** A plan long enough that the body always fills the region exactly. A fenced
 *  block keeps one uniquely greppable row per rendered line. */
function plan(headings: number): string {
	const rows = Array.from({ length: 300 }, (_, i) => `BODY-${String(i).padStart(4, "0")}`).join("\n");
	const sections = Array.from({ length: headings }, (_, i) => `# Section ${i + 1}\n\n\`\`\`\n${rows}\n\`\`\`\n`);
	return sections.join("\n");
}

let darkTheme = await getThemeByName("dark");

function makeOverlay(headings: number, header?: readonly string[]): PlanReviewOverlay {
	return new PlanReviewOverlay(
		plan(headings),
		{ promptTitle: PROMPT, options: OPTIONS, helpText: "esc cancel", ...(header ? { header } : {}) },
		{ onPick: vi.fn(), onCancel: vi.fn() },
	);
}

/** Terminal height the overlay reads through `process.stdout.rows`. */
let termRows = 40;

function render(overlay: PlanReviewOverlay, rows: number): string[] {
	termRows = rows;
	return overlay.render(WIDTH).map(line => stripVTControlCharacters(line));
}

/**
 * Height of the plan-body region: everything between the top chrome (top border,
 * plus the header rows and their closing rule when visible) and the rule that
 * precedes the prompt.
 */
function regionHeight(lines: readonly string[], visibleHeaderRows: number): number {
	const promptIdx = lines.findIndex(line => line.includes(PROMPT));
	expect(promptIdx).toBeGreaterThan(0);
	const start = visibleHeaderRows > 0 ? visibleHeaderRows + 2 : 1;
	return promptIdx - 1 - start;
}

/** A full-width horizontal rule (`├───…───┤`). */
function isRule(line: string): boolean {
	const box = theme.boxRound;
	return line.startsWith(box.teeRight) && line.endsWith(box.teeLeft) && line.includes(box.horizontal.repeat(4));
}

describe("PlanReviewOverlay header rows", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	let rowsDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
		termRows = 40;
		rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => termRows, set: () => {} });
	});

	afterEach(() => {
		if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
		else Reflect.deleteProperty(process.stdout, "rows");
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("renders header rows above the plan body, closed by a rule, on a tall terminal", () => {
		const lines = render(makeOverlay(1, HEADER), 60);
		const headerIndices = HEADER.map(text => lines.findIndex(line => line.includes(text)));
		expect(headerIndices).toEqual([1, 2, 3]);
		expect(isRule(lines[4]!)).toBe(true);

		const firstBody = lines.findIndex(line => /BODY-\d{4}/.test(line));
		expect(firstBody).toBeGreaterThan(4);
		expect(regionHeight(lines, HEADER.length)).toBeGreaterThanOrEqual(MIN_BODY_ROWS);
		// Header rows cost real chrome: the region shrinks by exactly header + rule.
		const withoutHeader = render(makeOverlay(1), 60);
		expect(regionHeight(lines, HEADER.length)).toBe(regionHeight(withoutHeader, 0) - (HEADER.length + 1));
	});

	it("drops the whole header on a terminal too short to afford it", () => {
		// Derive the overlay's chrome: when the terminal is short enough that
		// `regionRows` clamps to MIN_BODY_ROWS, total rows == chrome + MIN_BODY_ROWS.
		const SHORT_ROWS = 12;
		const bare = render(makeOverlay(1), SHORT_ROWS);
		expect(regionHeight(bare, 0)).toBe(MIN_BODY_ROWS);
		const chrome = bare.length - MIN_BODY_ROWS;
		// Precondition this test exists to cover.
		expect(SHORT_ROWS - (chrome + HEADER.length + 1)).toBeLessThan(MIN_BODY_ROWS);

		const lines = render(makeOverlay(1, HEADER), SHORT_ROWS);
		for (const text of HEADER) expect(lines.some(line => line.includes(text))).toBe(false);
		expect(regionHeight(lines, 0)).toBe(MIN_BODY_ROWS);
		// Whole-header drop, not a partial one: chrome is left untouched.
		expect(lines).toEqual(bare);
	});

	it("collapses the header to its headline on a 24-row terminal whose chrome already crowds the body", () => {
		// Same rule, driven by chrome rather than by an extreme terminal height:
		// 12 option rows + prompt + footer + 4 border/divider rows == 18, so the
		// header's 4 rows would leave the body below MIN_BODY_ROWS at 24 rows.
		const options = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
		const build = (header?: readonly string[]): PlanReviewOverlay =>
			new PlanReviewOverlay(
				plan(1),
				{ promptTitle: PROMPT, options, helpText: "esc cancel", ...(header ? { header } : {}) },
				{ onPick: vi.fn(), onCancel: vi.fn() },
			);
		const bare = render(build(), 24);
		expect(bare.length).toBe(24);
		// Body region == 24 - chrome, so this pins chrome at 18.
		const chrome = 24 - regionHeight(bare, 0);
		expect(chrome).toBe(18);
		expect(24 - (chrome + HEADER.length + 1)).toBeLessThan(MIN_BODY_ROWS);
		// One row plus its rule does fit, which is what the collapse buys.
		expect(24 - (chrome + 2)).toBeGreaterThanOrEqual(MIN_BODY_ROWS);

		const lines = render(build(HEADER), 24);
		expect(lines.some(line => line.includes(HEADER[0]))).toBe(true);
		for (const text of HEADER.slice(1)) expect(lines.some(line => line.includes(text))).toBe(false);
		expect(regionHeight(lines, 1)).toBe(24 - chrome - 2);
		// The whole header is affordable once the terminal is tall enough.
		for (const text of HEADER) expect(render(build(HEADER), 60).some(line => line.includes(text))).toBe(true);
	});

	it("prefers an explicit collapsed header over the first row of the full one", () => {
		const options = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
		const overlay = new PlanReviewOverlay(
			plan(1),
			{
				promptTitle: PROMPT,
				options,
				helpText: "esc cancel",
				header: HEADER,
				headerCollapsed: ["HDR-COLLAPSED"],
			},
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const short = render(overlay, 24);
		expect(short.some(line => line.includes("HDR-COLLAPSED"))).toBe(true);
		for (const text of HEADER) expect(short.some(line => line.includes(text))).toBe(false);
		// A tall terminal still gets the full block, never the collapsed stand-in.
		const tall = render(overlay, 60);
		for (const text of HEADER) expect(tall.some(line => line.includes(text))).toBe(true);
		expect(tall.some(line => line.includes("HDR-COLLAPSED"))).toBe(false);
	});

	it("treats an omitted header as an empty one", () => {
		expect(render(makeOverlay(1), 60)).toEqual(render(makeOverlay(1, []), 60));
		expect(render(makeOverlay(2), 60)).toEqual(render(makeOverlay(2, []), 60));
	});

	it("opens the sidebar columns from the header's closing rule, not the top border", () => {
		const box = theme.boxRound;
		const bare = render(makeOverlay(2), 60);
		// Baseline: without a header the split starts at the top border.
		expect(bare[0]!).toContain(box.teeDown);

		const lines = render(makeOverlay(2, HEADER), 60);
		expect(lines[0]!).not.toContain(box.teeDown);
		expect(lines[0]!.startsWith(box.topLeft)).toBe(true);
		for (let i = 0; i < HEADER.length; i++) expect(lines[i + 1]!).toContain(HEADER[i]!);
		const sidebarWidth = Math.max(18, Math.min(30, Math.round(WIDTH * 0.24)));
		expect(lines[HEADER.length + 1]!).toBe(stripVTControlCharacters(dividerSplitOpen(WIDTH, sidebarWidth)));
		// The region still closes with the sidebar-collapsing rule.
		expect(lines).toContain(stripVTControlCharacters(dividerSplit(WIDTH, sidebarWidth)));
	});

	it("dividerSplitOpen mirrors dividerSplit, tee flipped, same width and column", () => {
		const box = theme.boxRound;
		for (const sidebarWidth of [18, 24, 30]) {
			const open = dividerSplitOpen(WIDTH, sidebarWidth);
			const close = dividerSplit(WIDTH, sidebarWidth);
			expect(visibleWidth(open)).toBe(WIDTH);
			expect(visibleWidth(close)).toBe(WIDTH);
			const openPlain = stripVTControlCharacters(open);
			const closePlain = stripVTControlCharacters(close);
			expect([...openPlain].indexOf(box.teeDown)).toBe([...closePlain].indexOf(box.teeUp));
			expect(openPlain).not.toContain(box.teeUp);
			expect(openPlain.replaceAll(box.teeDown, box.teeUp)).toBe(closePlain);
		}
	});
});
