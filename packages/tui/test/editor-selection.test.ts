import { describe, expect, it } from "bun:test";
import {
	deleteRange,
	getSelectedText,
	isEmptyRange,
	normalizeRange,
	type Pos,
} from "@oh-my-pi/pi-tui/components/editor-selection";

const pos = (line: number, col: number): Pos => ({ line, col });

describe("editor-selection helpers", () => {
	describe("normalizeRange", () => {
		it("keeps order when anchor precedes cursor on the same line", () => {
			expect(normalizeRange(pos(0, 2), pos(0, 5))).toEqual({ start: pos(0, 2), end: pos(0, 5) });
		});

		it("swaps when the cursor precedes the anchor on the same line", () => {
			expect(normalizeRange(pos(0, 5), pos(0, 2))).toEqual({ start: pos(0, 2), end: pos(0, 5) });
		});

		it("orders across lines regardless of column", () => {
			expect(normalizeRange(pos(2, 1), pos(0, 9))).toEqual({ start: pos(0, 9), end: pos(2, 1) });
		});
	});

	describe("isEmptyRange", () => {
		it("is true when start equals end", () => {
			expect(isEmptyRange({ start: pos(1, 3), end: pos(1, 3) })).toBe(true);
		});

		it("is false when start and end differ", () => {
			expect(isEmptyRange({ start: pos(1, 3), end: pos(1, 4) })).toBe(false);
		});
	});

	describe("getSelectedText", () => {
		it("returns the substring within a single line", () => {
			expect(getSelectedText(["hello world"], { start: pos(0, 0), end: pos(0, 5) })).toBe("hello");
		});

		it("joins across multiple lines with newlines", () => {
			const lines = ["alpha", "beta", "gamma"];
			expect(getSelectedText(lines, { start: pos(0, 2), end: pos(2, 3) })).toBe("pha\nbeta\ngam");
		});
	});

	describe("deleteRange", () => {
		it("removes a span within a single line and lands the cursor at the start", () => {
			const result = deleteRange(["hello world"], { start: pos(0, 5), end: pos(0, 11) });
			expect(result.lines).toEqual(["hello"]);
			expect(result.cursor).toEqual(pos(0, 5));
		});

		it("joins the boundary lines when the span crosses lines", () => {
			const lines = ["alpha", "beta", "gamma"];
			const result = deleteRange(lines, { start: pos(0, 2), end: pos(2, 3) });
			expect(result.lines).toEqual(["alma"]);
			expect(result.cursor).toEqual(pos(0, 2));
		});

		it("does not mutate the input lines array", () => {
			const lines = ["hello world"];
			deleteRange(lines, { start: pos(0, 0), end: pos(0, 5) });
			expect(lines).toEqual(["hello world"]);
		});
	});
});
