/**
 * Carried-width contract: components may publish the exact `visibleWidth` of
 * each line of a render result, keyed by the result array itself. Consumers
 * (Box) must only ever observe widths that (a) match a direct measurement and
 * (b) were computed under the current width configuration — a Hangul
 * Compatibility Jamo width change must invalidate every published width.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	getPublishedLineWidths,
	getWidthConfigEpoch,
	publishLineWidths,
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui/utils";

afterEach(() => {
	resetHangulCompatibilityJamoWidthForTests();
});

describe("line-width sidecar", () => {
	it("returns published widths for the same array reference only", () => {
		const lines = ["abc", "漢字"];
		publishLineWidths(lines, [3, 4]);
		expect(getPublishedLineWidths(lines)).toEqual([3, 4]);
		// A value-equal but distinct array has no published widths.
		expect(getPublishedLineWidths(["abc", "漢字"])).toBeUndefined();
	});

	it("rejects a publication whose widths do not match the line count", () => {
		expect(() => publishLineWidths(["one", "two"], [3])).toThrow(RangeError);
	});

	it("keeps publication proof immutable from publishers and consumers", () => {
		const lines = ["hi"];
		const widths = [2];
		publishLineWidths(lines, widths);

		widths[0] = 99;
		const published = getPublishedLineWidths(lines);
		expect(published).toEqual([2]);
		expect(Object.isFrozen(published)).toBe(true);
		expect(Reflect.set(published ?? [], "0", 7)).toBe(false);
		expect(getPublishedLineWidths(lines)).toEqual([2]);
	});

	it("drops published widths after same-array content or length mutation", () => {
		const lines = ["hi"];
		publishLineWidths(lines, [2]);

		lines[0] = "hello";
		expect(getPublishedLineWidths(lines)).toBeUndefined();

		publishLineWidths(lines, [5]);
		lines.push("!");
		expect(getPublishedLineWidths(lines)).toBeUndefined();
	});

	it("drops published widths when the Hangul jamo width setting changes", () => {
		const jamo = "\u3131\u314F";
		const lines = [jamo];
		setHangulCompatibilityJamoWidth(1);
		publishLineWidths(lines, [visibleWidth(jamo)]);
		expect(getPublishedLineWidths(lines)).toEqual([visibleWidth(jamo)]);

		// Widths measured under the old setting must not survive the switch:
		// the same string now measures differently.
		setHangulCompatibilityJamoWidth(2);
		expect(getPublishedLineWidths(lines)).toBeUndefined();

		// Republishing under the new setting is visible again and exact.
		publishLineWidths(lines, [visibleWidth(jamo)]);
		expect(getPublishedLineWidths(lines)).toEqual([4]);
	});

	it("bumps the width-config epoch only on an effective setting change", () => {
		const before = getWidthConfigEpoch();
		setHangulCompatibilityJamoWidth(1);
		const afterFirst = getWidthConfigEpoch();
		expect(afterFirst).toBeGreaterThan(before);
		// No-op set: same value, no invalidation.
		setHangulCompatibilityJamoWidth(1);
		expect(getWidthConfigEpoch()).toBe(afterFirst);
	});

	it("re-measures Compatibility Jamo across the Warp/Ghostty switch; canonical Jamo is the control", () => {
		const compatJamo = "\u314e\u314f\u3134"; // ㅎㅏㄴ
		const canonicalConjoiningJamo = "\u1112\u1161\u11ab"; // 한 (decomposed)
		const compatLine = [compatJamo];
		const conjoiningLine = [canonicalConjoiningJamo];

		// Warp width (1): each Compatibility Jamo is one cell.
		setHangulCompatibilityJamoWidth(1);
		publishLineWidths(compatLine, [visibleWidth(compatJamo)]);
		publishLineWidths(conjoiningLine, [visibleWidth(canonicalConjoiningJamo)]);
		expect(getPublishedLineWidths(compatLine)).toEqual([3]);
		const conjoiningWidth = visibleWidth(canonicalConjoiningJamo);
		expect(getPublishedLineWidths(conjoiningLine)).toEqual([conjoiningWidth]);

		// Switching to Ghostty width (2) bumps the epoch, so every sidecar entry
		// drops — the invalidation is global, not per-string.
		setHangulCompatibilityJamoWidth(2);
		expect(getPublishedLineWidths(compatLine)).toBeUndefined();
		expect(getPublishedLineWidths(conjoiningLine)).toBeUndefined();

		// Compatibility Jamo now measures wide; canonical conjoining Jamo is the
		// control and re-measures to the same width as before.
		expect(visibleWidth(compatJamo)).toBe(6);
		expect(visibleWidth(canonicalConjoiningJamo)).toBe(conjoiningWidth);
	});
});
