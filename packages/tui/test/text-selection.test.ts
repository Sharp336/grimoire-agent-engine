import { describe, expect, it } from "bun:test";
import {
	applySelectionHighlight,
	applySelectionInput,
	orderedRange,
	reconstructSelectionText,
	type TextSelection,
} from "../src/text-selection";

describe("text-selection", () => {
	it("orders a backward drag", () => {
		const sel: TextSelection = { anchor: { row: 2, col: 4 }, head: { row: 1, col: 1 } };
		expect(orderedRange(sel)).toEqual({ start: { row: 1, col: 1 }, end: { row: 2, col: 4 } });
	});

	it("reconstructs a single-line slice and strips ANSI", () => {
		const lines = ["\x1b[1mal\x1b[0mpha beta"];
		const text = reconstructSelectionText(lines, {
			anchor: { row: 0, col: 0 },
			head: { row: 0, col: 5 },
		});
		expect(text).toBe("alpha");
	});

	it("reconstructs a multi-line range", () => {
		const lines = ["alpha", "beta", "gamma"];
		const text = reconstructSelectionText(lines, {
			anchor: { row: 0, col: 2 },
			head: { row: 2, col: 3 },
		});
		expect(text).toBe("pha\nbeta\ngam");
	});

	it("trims trailing spaces from copied lines", () => {
		const lines = ["hello   ", "world   "];
		const text = reconstructSelectionText(lines, {
			anchor: { row: 0, col: 0 },
			head: { row: 1, col: 8 },
		});
		expect(text).toBe("hello\nworld");
	});

	it("inverts the selected span", () => {
		const lines = ["alpha beta"];
		applySelectionHighlight(lines, { anchor: { row: 0, col: 0 }, head: { row: 0, col: 5 } });
		expect(lines[0]).toContain("\x1b[7m");
		expect(Bun.stripANSI(lines[0]!)).toBe("alpha beta");
	});

	it("starts a selection on left press and copies on generic release", () => {
		let sel = applySelectionInput(null, "\x1b[<0;1;1M");
		expect(sel?.action).toBe("start");
		sel = applySelectionInput(sel!.selection, "\x1b[<32;6;1M");
		expect(sel?.action).toBe("move");
		sel = applySelectionInput(sel!.selection, "\x1b[<3;6;1m");
		expect(sel?.action).toBe("copy");
		expect(reconstructSelectionText(["alpha beta"], sel!.selection!)).toBe("alpha");
	});

	it("consumes wheel without starting a selection", () => {
		const result = applySelectionInput(null, "\x1b[<64;1;1M");
		expect(result?.action).toBe("consumed");
		expect(result?.selection).toBeNull();
	});

	it("ignores a click-release with no drag", () => {
		let sel = applySelectionInput(null, "\x1b[<0;1;1M");
		sel = applySelectionInput(sel!.selection, "\x1b[<3;1;1m");
		expect(sel?.action).toBe("consumed");
		expect(sel?.selection).toBeNull();
	});
});
