import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CopySelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/copy-selector";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CopyTarget } from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\n";
const CANCEL = "\x07"; // ctrl+g, remapped to tui.select.cancel below

let darkTheme = await getThemeByName("dark");

// Flatten order (always expanded): msg:1, Block 1, Block 2, msg:2.
function makeRoots(): CopyTarget[] {
	return [
		{
			id: "msg:1",
			label: "Newest message",
			hint: "5 lines · 2 code",
			preview: "newest-preview-text",
			content: "FULL_MESSAGE",
			copyMessage: "Copied last message to clipboard",
			children: [
				{
					id: "msg:1:code:0",
					label: "Block 1",
					hint: "ts",
					language: "ts",
					preview: "alpha()",
					content: "BLOCK0",
					copyMessage: "Copied block 1",
				},
				{
					id: "msg:1:code:1",
					label: "Block 2",
					hint: "py",
					language: "python",
					preview: "beta()",
					content: "BLOCK1",
					copyMessage: "Copied block 2",
				},
			],
		},
		{
			id: "msg:2",
			label: "Older message",
			hint: "3 lines",
			preview: "older-text",
			content: "OLDER",
			copyMessage: "Copied message",
		},
	];
}

function render(component: CopySelectorComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("CopySelectorComponent", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("renders an outlined tree with code blocks nested under their message", () => {
		const out = render(new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel: vi.fn() }));
		expect(out).toContain(theme.boxRound.topLeft);
		expect(out).toContain("│");
		expect(out).toContain("Copy to clipboard");
		// Messages and their nested blocks are all visible (always expanded),
		// connected with /tree-style branch glyphs.
		expect(out).toContain("Newest message");
		expect(out).toContain("Block 1");
		expect(out).toContain("Block 2");
		expect(out).toContain("Older message");
		expect(out).toMatch(/[├└]/);
	});

	it("copies the message node itself on Enter", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		component.handleInput(ENTER); // cursor starts on the message node

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("FULL_MESSAGE");
	});

	it("navigates into a nested code block and copies it", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		component.handleInput(DOWN); // onto "Block 1"
		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("BLOCK0");
	});

	it("traverses past nested blocks to the older message, with the preview tracking the cursor", () => {
		const component = new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel: vi.fn() });

		component.handleInput(DOWN); // Block 1
		expect(render(component)).toContain("alpha()");

		component.handleInput(DOWN); // Block 2
		component.handleInput(DOWN); // Older message
		expect(render(component)).toContain("older-text");

		component.handleInput(UP); // back onto Block 2
		expect(render(component)).toContain("beta()");
	});

	it("drops cached preview content when invalidated", () => {
		const roots = makeRoots();
		const component = new CopySelectorComponent(roots, { onPick: vi.fn(), onCancel: vi.fn() });

		expect(render(component)).toContain("newest-preview-text");

		roots[0]!.preview = "updated-preview-text";
		component.invalidate();

		expect(render(component)).toContain("updated-preview-text");
		expect(render(component)).not.toContain("newest-preview-text");
	});

	it("quits on the cancel key", () => {
		const onCancel = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick: vi.fn(), onCancel });

		component.handleInput(CANCEL);

		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

// ─── SGR mouse helpers ──────────────────────────────────────────────────────

/** SGR left-button press at a 0-based frame-local row (protocol is 1-based). */
function sgrLeftClick(row0: number, col = 3): string {
	return `\x1b[<0;${col + 1};${row0 + 1}M`;
}

/** SGR pointer motion at a 0-based frame-local row. */
function sgrMotion(row0: number, col = 3): string {
	return `\x1b[<32;${col + 1};${row0 + 1}M`;
}

/** SGR left-button release at a 0-based frame-local row. */
function sgrRelease(row0: number, col = 3): string {
	return `\x1b[<0;${col + 1};${row0 + 1}m`;
}

/** SGR right-button press at a 0-based frame-local row. */
function sgrRightClick(row0: number, col = 3): string {
	return `\x1b[<2;${col + 1};${row0 + 1}M`;
}

/** SGR wheel-down notch (button 65). */
function sgrWheelDown(row0 = 0): string {
	return `\x1b[<65;1;${row0 + 1}M`;
}

/** SGR wheel-up notch (button 64). */
function sgrWheelUp(row0 = 0): string {
	return `\x1b[<64;1;${row0 + 1}M`;
}

/**
 * Render the component, strip VT, and return the plain lines array.
 * The index of each element is the 0-based frame-local row, matching
 * what parseSgrMouse delivers after converting 1-based protocol coords.
 */
function renderLines(component: CopySelectorComponent): string[] {
	return component.render(80).map(l => stripVTControlCharacters(l));
}

describe("CopySelectorComponent mouse interaction", () => {
	// Pin stdout.rows to 40 for all tests in this block so tree row counts and
	// scroll windows are deterministic regardless of the ambient terminal size.
	let baseRowsDesc: PropertyDescriptor | undefined;

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		baseRowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40, set: () => {} });
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
		if (baseRowsDesc) Object.defineProperty(process.stdout, "rows", baseRowsDesc);
		else Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
	});

	it("pointer motion over a target changes the preview without calling onPick", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		// Render to populate the screen-row map; cursor starts on msg:1.
		const lines = renderLines(component);
		// Find the row of "Older message" (msg:2).
		const olderRow = lines.findIndex(l => l.includes("Older message"));
		expect(olderRow).toBeGreaterThanOrEqual(1);

		component.handleInput(sgrMotion(olderRow));

		// After motion the preview follows the hovered target.
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("older-text");
		expect(onPick).not.toHaveBeenCalled();
	});

	it("left click on the initially selected target does not call onPick", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		const lines = renderLines(component);
		const msgRow = lines.findIndex(l => l.includes("Newest message"));
		expect(msgRow).toBeGreaterThanOrEqual(1);

		component.handleInput(sgrLeftClick(msgRow));

		expect(onPick).not.toHaveBeenCalled();
	});

	it("left click on a different target selects it, updates the preview, and does not call onPick", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		const lines = renderLines(component);
		const olderRow = lines.findIndex(l => l.includes("Older message"));
		expect(olderRow).toBeGreaterThanOrEqual(1);

		component.handleInput(sgrLeftClick(olderRow));

		// Preview now shows the older target's content.
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("older-text");
		expect(onPick).not.toHaveBeenCalled();
	});

	it("repeated clicks on the same target never call onPick", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		const lines = renderLines(component);
		const olderRow = lines.findIndex(l => l.includes("Older message"));
		expect(olderRow).toBeGreaterThanOrEqual(1);

		component.handleInput(sgrLeftClick(olderRow));
		component.handleInput(sgrLeftClick(olderRow));
		component.handleInput(sgrLeftClick(olderRow));

		expect(onPick).not.toHaveBeenCalled();
	});

	it("Enter after a left-click selection calls onPick with the clicked target", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		const lines = renderLines(component);
		const olderRow = lines.findIndex(l => l.includes("Older message"));
		expect(olderRow).toBeGreaterThanOrEqual(1);

		component.handleInput(sgrLeftClick(olderRow));
		component.handleInput(ENTER);

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].content).toBe("OLDER");
	});

	it("hover over target A while cursor stays on target B, then Enter calls onPick(A) exactly once", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		// Cursor starts on msg:1 (Newest message). Hover over Older message.
		const lines = renderLines(component);
		const olderRow = lines.findIndex(l => l.includes("Older message"));
		expect(olderRow).toBeGreaterThanOrEqual(1);

		component.handleInput(sgrMotion(olderRow));
		component.handleInput(ENTER);

		// Must pick the hovered target (Older message), not the keyboard cursor.
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]![0].id).toBe("msg:2");
	});

	it("wheel movement updates cursor/preview without copying and clamps at both ends", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		renderLines(component); // populate map

		// Scrolling up from the first node stays clamped at 0.
		for (let i = 0; i < 5; i++) component.handleInput(sgrWheelUp());
		const topOut = stripVTControlCharacters(component.render(80).join("\n"));
		expect(topOut).toContain("newest-preview-text"); // cursor still at first node
		expect(onPick).not.toHaveBeenCalled();

		// Scrolling down from the first node; 3 steps lands on flat index 3 (Older message).
		component.handleInput(sgrWheelDown());
		const afterDown = stripVTControlCharacters(component.render(80).join("\n"));
		expect(afterDown).toContain("older-text");
		expect(onPick).not.toHaveBeenCalled();

		// Scrolling further down from the last node stays clamped.
		for (let i = 0; i < 10; i++) component.handleInput(sgrWheelDown());
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("older-text");
		expect(onPick).not.toHaveBeenCalled();
	});

	it("wheel clears hover so the cursor (not prior hover) drives the preview afterwards", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

		const lines = renderLines(component);
		// Hover over Block 1 (index 1 in the flat list).
		const block1Row = lines.findIndex(l => l.includes("Block 1"));
		expect(block1Row).toBeGreaterThanOrEqual(1);
		component.handleInput(sgrMotion(block1Row));
		// Confirm hover is active.
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("alpha()");

		// A wheel event clears hover; the cursor (msg:1 = Newest message) drives preview.
		component.handleInput(sgrWheelUp());
		const afterWheel = stripVTControlCharacters(component.render(80).join("\n"));
		expect(afterWheel).toContain("newest-preview-text");
		expect(onPick).not.toHaveBeenCalled();
	});

	it("tree scroll window with a nonzero start offset maps screen rows to the correct targets", () => {
		// Force a small height so the tree cannot show all 4 flat nodes at once.
		const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 12, set: () => {} });
		try {
			const onPick = vi.fn();
			const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

			// Navigate to the last node (Older message, flat index 3) so the scroll window shifts.
			component.handleInput(DOWN); // Block 1
			component.handleInput(DOWN); // Block 2
			component.handleInput(DOWN); // Older message

			const lines = renderLines(component);
			// With the cursor at the last node the tree is scrolled; locate Older message's row.
			const olderRow = lines.findIndex(l => l.includes("Older message"));
			expect(olderRow).toBeGreaterThanOrEqual(1);

			// Click on a node that is NOT at screen row 1 (the default unscrolled position).
			// Block 1 should be at a different row when the window is scrolled.
			const block1Row = lines.findIndex(l => l.includes("Block 1"));
			if (block1Row >= 1) {
				component.handleInput(sgrLeftClick(block1Row));
				component.handleInput(ENTER);
				expect(onPick).toHaveBeenCalledTimes(1);
				expect(onPick.mock.calls[0]![0].id).toBe("msg:1:code:0");
			} else {
				// Block 1 scrolled off; clicking the first visible row should pick whatever is there.
				component.handleInput(sgrLeftClick(olderRow));
				component.handleInput(ENTER);
				expect(onPick).toHaveBeenCalledTimes(1);
				expect(onPick.mock.calls[0]![0].id).toBe("msg:2");
			}
		} finally {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
			else Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
	});

	it("release, right-click, non-left clicks, and out-of-range rows do not call onPick", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });
		renderLines(component);

		component.handleInput(sgrRelease(1));
		component.handleInput(sgrRightClick(1));
		// Middle-click: button 1.
		component.handleInput(`\x1b[<1;1;2M`);
		// Click on the top border row (row 0 — not in targetByScreenRow).
		component.handleInput(sgrLeftClick(0));
		// Click on a row far beyond any rendered target.
		component.handleInput(sgrLeftClick(999));

		expect(onPick).not.toHaveBeenCalled();
	});

	it("clicks on the divider, preview, footer, and bottom border rows do not call onPick", () => {
		const onPick = vi.fn();
		const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });
		const lines = renderLines(component);

		// Click on every non-tree row; none should cause onPick.
		for (let r = 0; r < lines.length; r++) {
			const plain = lines[r]!;
			// Only send clicks on rows that are NOT tree target rows (no "❯" or label text).
			if (plain.includes("Newest") || plain.includes("Older") || plain.includes("Block")) continue;
			component.handleInput(sgrLeftClick(r));
		}

		expect(onPick).not.toHaveBeenCalled();
	});

	it("short height does not crash and creates no phantom target rows beyond rendered targets", () => {
		// Render at 6 rows total — below the normal chrome requirement.
		const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 6, set: () => {} });
		try {
			const onPick = vi.fn();
			const component = new CopySelectorComponent(makeRoots(), {
				onPick,
				onCancel: vi.fn(),
			});

			// render() must not throw.
			const lines = component.render(80);
			expect(lines.length).toBeGreaterThan(0);

			// Clicking a row just past the end of the rendered output is harmless.
			component.handleInput(sgrLeftClick(lines.length));
			component.handleInput(sgrLeftClick(lines.length + 5));
			expect(onPick).not.toHaveBeenCalled();
		} finally {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
			else Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
	});

	it("motion outside every mapped target clears hover so the cursor drives the preview", () => {
		const component = new CopySelectorComponent(makeRoots(), {
			onPick: vi.fn(),
			onCancel: vi.fn(),
		});

		const lines = renderLines(component);
		// First hover over a known target row.
		const olderRow = lines.findIndex(l => l.includes("Older message"));
		expect(olderRow).toBeGreaterThanOrEqual(1);
		component.handleInput(sgrMotion(olderRow));
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("older-text");

		// Now move outside any mapped row (the top border, row 0).
		component.handleInput(sgrMotion(0));
		// Hover cleared → cursor (msg:1) drives the preview.
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("newest-preview-text");
	});

	it("footer contains the four expected hint labels", () => {
		const component = new CopySelectorComponent(makeRoots(), {
			onPick: vi.fn(),
			onCancel: vi.fn(),
		});
		const out = stripVTControlCharacters(component.render(80).join("\n"));
		expect(out).toContain("move");
		expect(out).toContain("preview");
		expect(out).toContain("select");
		expect(out).toContain("copy");
		expect(out).toContain("quit");
	});
	it("sub-9-row compositor: when all tree rows are sliced from the top no click selects a target", () => {
		// At height=2 the 9-row render is sliced 7 rows from the top, leaving
		// only 2 physical rows that are all chrome (topBorder sliced off too).
		// No tree target should be addressable; cursor stays at msg:1.
		const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 2, set: () => {} });
		try {
			const onPick = vi.fn();
			const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

			renderLines(component);

			// Clicks anywhere on the 2-row physical screen must not select any target.
			component.handleInput(sgrLeftClick(0));
			component.handleInput(sgrLeftClick(1));
			component.handleInput(ENTER);

			// Cursor never moved; Enter commits the initial target (msg:1).
			expect(onPick).toHaveBeenCalledTimes(1);
			expect(onPick.mock.calls[0]![0].id).toBe("msg:1");
		} finally {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
			else Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
	});

	it("height=8 bottom-anchor compositor: visible tree rows map to physical screen rows after top-slice", () => {
		// At height=8 the 9-row render loses frame row 0 (topBorder) from the
		// top. Physical screen row 0 shows frame row 1 (msg:1) and screen row 1
		// shows frame row 2 (Block 1). The map must use these physical indices.
		const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 8, set: () => {} });
		try {
			const onPick = vi.fn();
			const component = new CopySelectorComponent(makeRoots(), { onPick, onCancel: vi.fn() });

			// render() produces 9 lines; mimic the TUI's bottom-anchor slice to
			// get the 8 lines actually displayed on the physical screen.
			const renderOutput = component.render(80);
			const sliced = Array.from(renderOutput)
				.slice(renderOutput.length - 8)
				.map(l => stripVTControlCharacters(l));

			// msg:1 must be at physical screen row 0, Block 1 at row 1.
			const msgRow = sliced.findIndex(l => l.includes("Newest message"));
			const blockRow = sliced.findIndex(l => l.includes("Block 1"));
			expect(msgRow).toBe(0);
			expect(blockRow).toBe(1);

			// Click msg:1 (screen row 0), then Block 1 (screen row 1).
			component.handleInput(sgrLeftClick(msgRow));
			component.handleInput(sgrLeftClick(blockRow));
			// Enter commits the last-clicked target: Block 1.
			component.handleInput(ENTER);

			expect(onPick).toHaveBeenCalledTimes(1);
			expect(onPick.mock.calls[0]![0].id).toBe("msg:1:code:0");
		} finally {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
			else Object.defineProperty(process.stdout, "rows", { configurable: true, value: undefined, writable: true });
		}
	});
});
