import { describe, expect, it } from "bun:test";
import type { HashlineEdit } from "@oh-my-pi/pi-coding-agent/edit";
import {
	applyHashlineEdits,
	buildCorrectedEdit,
	computeLineHash,
	computeLineShiftMap,
	FileReadCache,
	HashlineMismatchError,
	parseHashline,
	tryShiftAnchors,
} from "@oh-my-pi/pi-coding-agent/edit";

const pl = (text: string): string => text;
const tag = (line: number, content: string): string => `${line}${computeLineHash(line, content)}`;

describe("buildCorrectedEdit", () => {
	it("replaces a single stale anchor in an op line", () => {
		const remaps = new Map([["3ab", "3xy"]]);
		const input = "≔ 3ab";
		expect(buildCorrectedEdit(remaps, input)).toBe("≔ 3xy");
	});

	it("replaces both anchors in a range op", () => {
		const remaps = new Map([
			["3ab", "3xy"],
			["5cd", "5zz"],
		]);
		const input = "≔ 3ab..5cd";
		expect(buildCorrectedEdit(remaps, input)).toBe("≔ 3xy..5zz");
	});

	it("replaces anchors in insert-before and insert-after ops", () => {
		const remaps = new Map([["10sr", "10zz"]]);
		expect(buildCorrectedEdit(remaps, "« 10sr")).toBe("« 10zz");
		expect(buildCorrectedEdit(remaps, "» 10sr")).toBe("» 10zz");
	});

	it("preserves payload lines starting with HL_EDIT_SEP", () => {
		const remaps = new Map([["3ab", "3xy"]]);
		const input = ` 3ab should not change`;
		expect(buildCorrectedEdit(remaps, input)).toBe(` 3ab should not change`);
	});

	it("preserves § section headers", () => {
		const remaps = new Map([["3ab", "3xy"]]);
		const input = "§ src/foo.ts";
		expect(buildCorrectedEdit(remaps, input)).toBe("§ src/foo.ts");
	});

	it("preserves blank lines", () => {
		const remaps = new Map([["3ab", "3xy"]]);
		const input = "";
		expect(buildCorrectedEdit(remaps, input)).toBe("");
	});

	it("returns input unchanged when remaps is empty", () => {
		const input = "≔ 3ab..5cd";
		expect(buildCorrectedEdit(new Map(), input)).toBe(input);
	});

	it("returns input unchanged when no anchors match remaps", () => {
		const remaps = new Map([["99zz", "99yy"]]);
		const input = "≔ 3ab..5cd";
		expect(buildCorrectedEdit(remaps, input)).toBe(input);
	});

	it("handles multi-line edit input with mixed line types", () => {
		const remaps = new Map([
			["3ab", "3xy"],
			["5cd", "5zz"],
		]);
		const input = ["≔ 3ab..5cd", ` replacement text`, "» 7ef", "", "§ other.ts", "≔ 10gh"].join("\n");
		const expected = ["≔ 3xy..5zz", ` replacement text`, "» 7ef", "", "§ other.ts", "≔ 10gh"].join("\n");
		expect(buildCorrectedEdit(remaps, input)).toBe(expected);
	});

	it("does not replace anchors that look like digits in payload content", () => {
		const remaps = new Map([["3ab", "3xy"]]);
		// Payload line — should NOT be touched
		const input = ` some text with 3ab in it`;
		expect(buildCorrectedEdit(remaps, input)).toBe(input);
	});

	it("input with mixed anchors (some stale, some fresh)", () => {
		const remaps = new Map<string, string>([["2ab", "2cd"]]);
		const input = `≔ 1ef..2ab\n${pl("replacement")}`;
		const result = buildCorrectedEdit(remaps, input);
		expect(result).toBe(`≔ 1ef..2cd\n${pl("replacement")}`);
	});

	it("anchor that appears only once in a multi-op edit", () => {
		const remaps = new Map<string, string>([["3ab", "3cd"]]);
		const input = `≔ 1aa..2bb\n${pl("x")}\n» 3ab\n${pl("y")}`;
		const result = buildCorrectedEdit(remaps, input);
		expect(result).toBe(`≔ 1aa..2bb\n${pl("x")}\n» 3cd\n${pl("y")}`);
	});
});

describe("computeLineShiftMap", () => {
	it("maps identical text 1:1", () => {
		const text = "aaa\nbbb\nccc";
		const map = computeLineShiftMap(text, text);
		expect(map.get(1)).toBe(1);
		expect(map.get(2)).toBe(2);
		expect(map.get(3)).toBe(3);
	});

	it("shifts lines down when a line is inserted at the top", () => {
		const prev = "aaa\nbbb\nccc";
		const cur = "NEW\naaa\nbbb\nccc";
		const map = computeLineShiftMap(prev, cur);
		expect(map.get(1)).toBe(2);
		expect(map.get(2)).toBe(3);
		expect(map.get(3)).toBe(4);
	});

	it("shifts lines up when a line is deleted at the top", () => {
		const prev = "aaa\nbbb\nccc";
		const cur = "bbb\nccc";
		const map = computeLineShiftMap(prev, cur);
		expect(map.get(1)).toBe(undefined);
		expect(map.get(2)).toBe(1);
		expect(map.get(3)).toBe(2);
	});

	it("maps a modified-in-place line to undefined", () => {
		const prev = "aaa\nbbb\nccc";
		const cur = "aaa\nCHANGED\nccc";
		const map = computeLineShiftMap(prev, cur);
		expect(map.get(1)).toBe(1);
		expect(map.get(2)).toBe(undefined);
		expect(map.get(3)).toBe(3);
	});

	it("handles multiple insertions", () => {
		const prev = "aaa\nbbb";
		const cur = "aaa\nINS1\nINS2\nbbb";
		const map = computeLineShiftMap(prev, cur);
		expect(map.get(1)).toBe(1);
		expect(map.get(2)).toBe(4);
	});

	it("handles multiple deletions", () => {
		const prev = "aaa\nDEL1\nDEL2\nbbb";
		const cur = "aaa\nbbb";
		const map = computeLineShiftMap(prev, cur);
		expect(map.get(1)).toBe(1);
		expect(map.get(2)).toBe(undefined);
		expect(map.get(3)).toBe(undefined);
		expect(map.get(4)).toBe(2);
	});

	it("handles empty previous text", () => {
		const prev = "";
		const cur = "aaa\nbbb";
		const map = computeLineShiftMap(prev, cur);
		// Empty string splits to [""], so line 1 exists and maps to undefined
		expect(map.size).toBe(1);
	});

	it("handles single-line texts", () => {
		const map = computeLineShiftMap("aaa", "bbb");
		expect(map.get(1)).toBe(undefined);
	});

	it("empty cur → all prev lines map to undefined", () => {
		const map = computeLineShiftMap("a\nb\nc", "");
		expect(map.get(1)).toBeUndefined();
		expect(map.get(2)).toBeUndefined();
		expect(map.get(3)).toBeUndefined();
	});

	it("empty prev and empty cur → single line maps to itself", () => {
		const map = computeLineShiftMap("", "");
		expect(map.get(1)).toBe(1);
	});

	it("large file performance sanity (1000+ lines)", () => {
		const prevLines = Array.from({ length: 1000 }, (_, i) => `line${i + 1}`);
		const prev = prevLines.join("\n");
		const cur = `header1\nheader2\n${prev}`;
		const map = computeLineShiftMap(prev, cur);
		expect(map.size).toBe(1000);
		expect(map.get(1)).toBe(3);
		expect(map.get(500)).toBe(502);
		expect(map.get(1000)).toBe(1002);
	});

	it("lines inserted in middle shift following lines forward", () => {
		const prev = "a\nb\nc\nd";
		const cur = "a\nb\nx\ny\nc\nd";
		const map = computeLineShiftMap(prev, cur);
		expect(map.get(1)).toBe(1);
		expect(map.get(2)).toBe(2);
		expect(map.get(3)).toBe(5); // c shifted to line 5
		expect(map.get(4)).toBe(6); // d shifted to line 6
	});

	it("mixed changes: some deleted, some added, some modified", () => {
		const map = computeLineShiftMap("line1\nkeep2\nkeep3\nold4\nkeep5", "keep2\nkeep3\nnew4\nnew5\nkeep5");
		expect(map.get(1)).toBeUndefined(); // line1 deleted
		expect(map.get(2)).toBe(1); // keep2 → line 1 (shifted up by 1)
		expect(map.get(3)).toBe(2); // keep3 → line 2 (shifted up by 1)
		expect(map.get(4)).toBeUndefined(); // old4 changed to new4
		expect(map.get(5)).toBe(5); // keep5 unchanged
	});

	it("trailing newline in prev but not in cur", () => {
		const map = computeLineShiftMap("a\nb\nc\n", "a\nb\nc");
		expect(map.get(1)).toBe(1);
		expect(map.get(2)).toBe(2);
		expect(map.get(3)).toBeUndefined(); // trailing newline corrupts shift
		expect(map.get(4)).toBe(4); // trailing empty maps to itself
	});

	it("both have trailing newline produces consistent mapping", () => {
		const map = computeLineShiftMap("a\nb\nc\n", "a\nb\nc\nd\n");
		expect(map.get(3)).toBe(3);
		expect(map.get(4)).toBe(5); // trailing empty shifted to line 5
	});
});

describe("tryShiftAnchors", () => {
	const makeDelete = (line: number, hash: string): HashlineEdit => ({
		kind: "delete",
		anchor: { line, hash },
		lineNum: line,
		index: 0,
	});

	const makeInsertBefore = (line: number, hash: string, text: string): HashlineEdit => ({
		kind: "insert",
		cursor: { kind: "before_anchor", anchor: { line, hash } },
		text,
		lineNum: line,
		index: 0,
	});

	const makeInsertAfter = (line: number, hash: string, text: string): HashlineEdit => ({
		kind: "insert",
		cursor: { kind: "after_anchor", anchor: { line, hash } },
		text,
		lineNum: line,
		index: 0,
	});

	const makeInsertBof = (text: string): HashlineEdit => ({
		kind: "insert",
		cursor: { kind: "bof" },
		text,
		lineNum: 0,
		index: 0,
	});

	it("shifts delete anchor when lines inserted above", () => {
		const cached = "aaa\nbbb\nccc";
		const current = "NEW\naaa\nbbb\nccc";
		const edits = [makeDelete(3, "xx")];
		const { shifted, shiftCount } = tryShiftAnchors(edits, cached, current);
		expect(shifted[0].kind).toBe("delete");
		if (shifted[0].kind === "delete") expect(shifted[0].anchor.line).toBe(4);
		expect(shiftCount).toBe(1);
	});

	it("keeps original anchor when line content changed", () => {
		const cached = "aaa\nbbb\nccc";
		const current = "aaa\nCHANGED\nccc";
		const edits = [makeDelete(2, "xx")];
		const { shifted, shiftCount } = tryShiftAnchors(edits, cached, current);
		if (shifted[0].kind === "delete") expect(shifted[0].anchor.line).toBe(2);
		expect(shiftCount).toBe(0);
	});

	it("shifts before_anchor cursor when lines inserted above", () => {
		const cached = "aaa\nbbb\nccc";
		const current = "NEW\naaa\nbbb\nccc";
		const edits = [makeInsertBefore(3, "xx", "text")];
		const { shifted, shiftCount } = tryShiftAnchors(edits, cached, current);
		if (shifted[0].kind === "insert" && shifted[0].cursor.kind === "before_anchor") {
			expect(shifted[0].cursor.anchor.line).toBe(4);
		}
		expect(shiftCount).toBe(1);
	});

	it("shifts after_anchor cursor when lines inserted above", () => {
		const cached = "aaa\nbbb\nccc";
		const current = "NEW\naaa\nbbb\nccc";
		const edits = [makeInsertAfter(2, "xx", "text")];
		const { shifted, shiftCount } = tryShiftAnchors(edits, cached, current);
		if (shifted[0].kind === "insert" && shifted[0].cursor.kind === "after_anchor") {
			expect(shifted[0].cursor.anchor.line).toBe(3);
		}
		expect(shiftCount).toBe(1);
	});

	it("does not shift bof/eof cursor edits", () => {
		const cached = "aaa\nbbb";
		const current = "NEW\naaa\nbbb";
		const edits = [makeInsertBof("text")];
		const { shifted, shiftCount } = tryShiftAnchors(edits, cached, current);
		expect(shifted[0]).toEqual(edits[0]);
		expect(shiftCount).toBe(0);
	});

	it("handles identical cached and current text", () => {
		const text = "aaa\nbbb\nccc";
		const edits = [makeDelete(2, "xx")];
		const { shifted, shiftCount } = tryShiftAnchors(edits, text, text);
		expect(shifted[0]).toEqual(edits[0]);
		expect(shiftCount).toBe(0);
	});

	it("handles empty edits array", () => {
		const { shifted, shiftCount } = tryShiftAnchors([], "aaa", "bbb");
		expect(shifted).toEqual([]);
		expect(shiftCount).toBe(0);
	});

	it("recomputes anchor hash when shifting (non-significant line uses line-number seed)", () => {
		const cached = "aaa\nbbb\nccc";
		const current = "NEW\naaa\nbbb\nccc";
		const edits = [makeDelete(3, "sr")];
		const { shifted } = tryShiftAnchors(edits, cached, current);
		if (shifted[0].kind === "delete") {
			// "ccc" is significant (contains letters), so seed=0 for both
			// line 3 and line 4 → hash is the same. But the hash must be
			// recomputed, not preserved verbatim.
			expect(shifted[0].anchor.hash).toBe(computeLineHash(4, "ccc"));
			expect(shifted[0].anchor.line).toBe(4);
		}
	});

	it("recomputes hash for non-significant line (content-only hash)", () => {
		// "}" is non-significant → computeLineHash ignores line number.
		// Both line 2 and line 3 with "}" content produce the same hash.
		const cached = "fn()\n}";
		const current = "NEW\nfn()\n}";
		const oldHash = computeLineHash(2, "}");
		const edits = [makeDelete(2, oldHash)];
		const { shifted, shiftCount } = tryShiftAnchors(edits, cached, current);
		expect(shiftCount).toBe(1);
		if (shifted[0].kind === "delete") {
			expect(shifted[0].anchor.line).toBe(3);
			// Hash is recomputed for line 3 — since content is "}" and
			// upstream/main uses content-only hashing, the hash equals oldHash.
			expect(shifted[0].anchor.hash).toBe(computeLineHash(3, "}"));
		}
	});

	it("all anchors can be shifted correctly", () => {
		const prev = "a\nb\nc\nd\ne";
		const cur = "x\nx\na\nb\nc\nd\ne";
		const edits: HashlineEdit[] = [
			makeDelete(3, computeLineHash(3, "c")),
			makeInsertAfter(5, computeLineHash(5, "e"), "new-line"),
		];
		const { shifted, shiftCount } = tryShiftAnchors(edits, prev, cur);
		expect(shiftCount).toBe(2);
		expect(shifted[0].kind).toBe("delete");
		if (shifted[0].kind === "delete") expect(shifted[0].anchor.line).toBe(5);
		expect(shifted[1].kind).toBe("insert");
		if (shifted[1].kind === "insert" && shifted[1].cursor.kind === "after_anchor")
			expect(shifted[1].cursor.anchor.line).toBe(7);
	});

	it("no anchors need shifting (anchors already match) → shiftCount=0", () => {
		const prev = "a\nb\nc";
		const cur = "a\nb\nc";
		const edits: HashlineEdit[] = [makeDelete(2, computeLineHash(2, "b"))];
		const { shifted, shiftCount } = tryShiftAnchors(edits, prev, cur);
		expect(shiftCount).toBe(0);
		expect(shifted[0]).toBe(edits[0]); // same object (no copy)
	});

	it("delete anchor for a line that was deleted in curr → kept as-is (will fail validation)", () => {
		const prev = "a\nb\nc";
		const cur = "a\nc"; // line 2 (b) was deleted
		const edits: HashlineEdit[] = [makeDelete(2, computeLineHash(2, "b"))];
		const { shifted, shiftCount } = tryShiftAnchors(edits, prev, cur);
		expect(shiftCount).toBe(0);
		expect(shifted[0].kind).toBe("delete");
		if (shifted[0].kind === "delete") expect(shifted[0].anchor.line).toBe(2);
	});

	it("multiple edits, some shiftable and some not", () => {
		const prev = "a\nb\nc\nd\ne\nf";
		const cur = "a\nx\ny\nz\nd\ne\nf"; // b,c replaced by x,y,z → lines shifted
		const edits: HashlineEdit[] = [
			makeDelete(1, computeLineHash(1, "a")), // line 1: same → no shift
			makeDelete(2, computeLineHash(2, "b")), // line 2: changed → can't shift
			makeDelete(4, computeLineHash(4, "d")), // line 4: shifted to line 5
		];
		const { shifted, shiftCount } = tryShiftAnchors(edits, prev, cur);
		expect(shiftCount).toBe(1); // only line 4→5 shiftable
		expect(shifted[2].kind).toBe("delete");
		if (shifted[2].kind === "delete") expect(shifted[2].anchor.line).toBe(5);
	});

	it("empty prev text → single empty line gets shifted", () => {
		const prev = "";
		const cur = "a\nb\nc";
		const edits: HashlineEdit[] = [makeDelete(1, computeLineHash(1, ""))];
		const { shiftCount } = tryShiftAnchors(edits, prev, cur);
		expect(shiftCount).toBe(1); // empty line got shifted
	});
});

describe("FileReadCache", () => {
	it("recordContiguous after recordFullFile preserves isPartial false (fullContent still valid)", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__cache-interaction__.ts";
		cache.recordFullFile(fakePath, "aaa\nbbb\nccc");
		const snap1 = cache.get(fakePath);
		expect(snap1?.isPartial).toBe(false);
		expect(snap1?.fullContent).toBe("aaa\nbbb\nccc");

		// Now record a contiguous partial — should NOT flip isPartial since fullContent is still valid
		cache.recordContiguous(fakePath, 1, ["aaa", "bbb", "ccc"]);
		const snap2 = cache.get(fakePath);
		expect(snap2?.isPartial).toBe(false);
		expect(snap2?.fullContent).toBe("aaa\nbbb\nccc");
	});

	it("recordFullFile after recordContiguous sets isPartial to false", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__cache-interaction2__.ts";
		cache.recordContiguous(fakePath, 1, ["aaa", "bbb"]);
		const snap1 = cache.get(fakePath);
		expect(snap1?.isPartial).toBe(true);

		cache.recordFullFile(fakePath, "aaa\nbbb\nccc");
		const snap2 = cache.get(fakePath);
		expect(snap2?.isPartial).toBe(false);
		expect(snap2?.fullContent).toBe("aaa\nbbb\nccc");
	});

	it("conflicting recordContiguous drops fullContent", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__cache-interaction3__.ts";
		cache.recordFullFile(fakePath, "aaa\nbbb\nccc");
		expect(cache.get(fakePath)?.fullContent).toBe("aaa\nbbb\nccc");

		// Conflicting partial record should reset the snapshot
		cache.recordContiguous(fakePath, 1, ["aaa", "CHANGED", "ccc"]);
		const snap = cache.get(fakePath);
		expect(snap?.fullContent).toBeUndefined();
		expect(snap?.isPartial).toBe(true);
	});

	it("get for unrecorded path returns null", () => {
		const cache = new FileReadCache();
		expect(cache.get("/tmp/__nonexistent__.ts")).toBeNull();
	});

	it("record partial content, then full content → state reflects full", () => {
		const cache = new FileReadCache();
		cache.recordContiguous("/tmp/__cache-full-record.ts", 1, ["line1", "line2"]);
		expect(cache.get("/tmp/__cache-full-record.ts")?.isPartial).toBe(true);
		expect(cache.get("/tmp/__cache-full-record.ts")?.fullContent).toBeUndefined();

		cache.recordFullFile("/tmp/__cache-full-record.ts", "line1\nline2\nline3");
		const snap = cache.get("/tmp/__cache-full-record.ts");
		expect(snap?.isPartial).toBe(false);
		expect(snap?.fullContent).toBe("line1\nline2\nline3");
		expect(snap?.lines.size).toBe(3);
	});

	it("record full, then partial with different range (no conflict) → fullContent preserved, isPartial stays false", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/tmp/__cache-partial-range.ts", "a\nb\nc\nd\ne");
		const before = cache.get("/tmp/__cache-partial-range.ts");
		expect(before?.fullContent).toBe("a\nb\nc\nd\ne");
		expect(before?.isPartial).toBe(false);

		// Record a subset (lines 3-4 only) — no conflict with existing entries for those lines
		cache.recordContiguous("/tmp/__cache-partial-range.ts", 3, ["c", "d"]);
		const after = cache.get("/tmp/__cache-partial-range.ts");
		expect(after?.fullContent).toBe("a\nb\nc\nd\ne"); // fullContent preserved
		expect(after?.isPartial).toBe(false); // stays false — fullContent is still valid
		expect(after?.lines.size).toBe(5); // merged (existing lines weren't replaced)
	});

	it("record same line twice with different content → conflict detected, snapshot replaced", () => {
		const cache = new FileReadCache();
		cache.recordContiguous("/tmp/__cache-double-write.ts", 1, ["first"]);
		cache.recordContiguous("/tmp/__cache-double-write.ts", 1, ["second"]);
		const snap = cache.get("/tmp/__cache-double-write.ts");
		expect(snap?.lines.get(1)).toBe("second");
		expect(snap?.lines.size).toBe(1);
	});

	it("record same line with same content → no conflict, merged", () => {
		const cache = new FileReadCache();
		cache.recordContiguous("/tmp/__cache-same-content.ts", 1, ["same"]);
		cache.recordContiguous("/tmp/__cache-same-content.ts", 1, ["same"]);
		const snap = cache.get("/tmp/__cache-same-content.ts");
		expect(snap?.lines.get(1)).toBe("same");
	});

	it("record sparse entries", () => {
		const cache = new FileReadCache();
		cache.recordSparse("/tmp/__cache-sparse.ts", [
			[1, "import x"],
			[5, "function foo()"],
		]);
		const snap = cache.get("/tmp/__cache-sparse.ts");
		expect(snap?.isPartial).toBe(true);
		expect(snap?.lines.get(1)).toBe("import x");
		expect(snap?.lines.get(5)).toBe("function foo()");
		expect(snap?.fullContent).toBeUndefined();
	});

	it("invalidate single path clears it", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/tmp/__cache-invalidate.ts", "hello");
		expect(cache.get("/tmp/__cache-invalidate.ts")).not.toBeNull();
		cache.invalidate("/tmp/__cache-invalidate.ts");
		expect(cache.get("/tmp/__cache-invalidate.ts")).toBeNull();
	});

	it("invalidateFullContent drops fullContent but keeps lines", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/tmp/__cache-keep-lines.ts", "a\nb\nc");
		cache.invalidateFullContent("/tmp/__cache-keep-lines.ts");
		const snap = cache.get("/tmp/__cache-keep-lines.ts");
		expect(snap?.fullContent).toBeUndefined();
		expect(snap?.isPartial).toBe(true);
		expect(snap?.lines.get(1)).toBe("a");
	});

	it("clear removes everything", () => {
		const cache = new FileReadCache();
		cache.recordFullFile("/tmp/__cache-clear1.ts", "data");
		cache.recordFullFile("/tmp/__cache-clear2.ts", "data2");
		cache.clear();
		expect(cache.get("/tmp/__cache-clear1.ts")).toBeNull();
		expect(cache.get("/tmp/__cache-clear2.ts")).toBeNull();
	});
});

describe("stale anchor recovery simulation", () => {
	it("stale anchors → HashlineMismatchError with remaps", () => {
		const file = "const x = 1;\nconst y = 2;\nconst z = 3;";
		// Use a wrong hash for line 2
		const edits = parseHashline(`≔ ${tag(1, "const x = 1;")}..${tag(2, "const x = 1;")}\n${pl("const y = 42;")}`);
		// line 2's hash is for "const x = 1;" but the actual content is "const y = 2;"
		expect(() => applyHashlineEdits(file, edits)).toThrow(HashlineMismatchError);
	});

	it("use error.remaps + buildCorrectedEdit to recover", () => {
		const file = "const x = 1;\nconst y = 2;\nconst z = 3;";
		const correctHash1 = tag(1, "const x = 1;");
		const staleHash2 = `2${computeLineHash(2, "const x = 1;")}`; // hash of wrong content
		const diff = `≔ ${correctHash1}..${staleHash2}\n${pl("const y = 42;")}`;
		const edits = parseHashline(diff);

		try {
			applyHashlineEdits(file, edits);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const mismatchErr = err as HashlineMismatchError;
			expect(mismatchErr.remaps.size).toBeGreaterThan(0);
			// Build corrected edit from remaps
			const correctedInput = buildCorrectedEdit(mismatchErr.remaps, diff);
			const correctedEdits = parseHashline(correctedInput);
			const result = applyHashlineEdits(file, correctedEdits);
			expect(result.lines).toBe("const y = 42;\nconst z = 3;");
		}
	});

	it("correct anchors produce no error (no recovery needed)", () => {
		const file = "const x = 1;\nconst y = 2;\nconst z = 3;";
		const edits = parseHashline(`» ${tag(2, "const y = 2;")}\n${pl("const w = 0;")}`);
		const result = applyHashlineEdits(file, edits);
		expect(result.lines).toBe("const x = 1;\nconst y = 2;\nconst w = 0;\nconst z = 3;");
	});

	it("single anchor stale → can recover single anchor", () => {
		const file = "lineA\nlineB\nlineC";
		const staleHash = computeLineHash(2, "wrongContent");
		const diff = `» 2${staleHash}\n${pl("lineNEW")}`;
		const edits = parseHashline(diff);

		try {
			applyHashlineEdits(file, edits);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const corrected = buildCorrectedEdit((err as HashlineMismatchError).remaps, diff);
			const result = applyHashlineEdits(file, parseHashline(corrected));
			expect(result.lines).toBe("lineA\nlineB\nlineNEW\nlineC");
		}
	});
});

describe("full recovery workflow integration", () => {
	it("stale anchors due to lines inserted upstream → shift recovers correctly", () => {
		const fileBeforeEdit = "function foo() {\n  return 1;\n}\n";
		const fileCurrent = "// header\n// license\nfunction foo() {\n  return 1;\n}\n";

		// Edit anchored against the cached version (line 2 = "  return 1;")
		const hashReturn = computeLineHash(2, "  return 1;");
		const edits = parseHashline(
			`≔ 1${computeLineHash(1, "function foo() {")}..2${hashReturn}\n${pl("function foo() {")}\n${pl("  return 42;")}`,
		);

		// Direct apply fails
		expect(() => applyHashlineEdits(fileCurrent, edits)).toThrow(HashlineMismatchError);

		// Shift and recover
		const { shifted } = tryShiftAnchors(edits, fileBeforeEdit, fileCurrent);
		const result = applyHashlineEdits(fileCurrent, shifted);
		expect(result.lines).toBe("// header\n// license\nfunction foo() {\n  return 42;\n}\n");
	});

	it("stale anchors due to lines deleted upstream → shift recovers correctly", () => {
		const fileBeforeEdit = "import old\nimport unused\nconst x = 1;\nconst y = 2;\n";
		const fileCurrent = "const x = 1;\nconst y = 2;\n";

		const hashX = tag(3, "const x = 1;");
		const edits = parseHashline(`» ${hashX}\n${pl("const z = 3;")}`);

		// Direct apply fails (anchors against old file: line 3)
		expect(() => applyHashlineEdits(fileCurrent, edits)).toThrow(HashlineMismatchError);

		const { shifted } = tryShiftAnchors(edits, fileBeforeEdit, fileCurrent);
		const result = applyHashlineEdits(fileCurrent, shifted);
		expect(result.lines).toBe("const x = 1;\nconst z = 3;\nconst y = 2;\n");
	});

	it("content change + structural shift simultaneously → only structural lines recoverable", () => {
		const cached = "keep1\nwill-change\nkeep2";
		const current = "prefix\nkeep1\nMODIFIED\nkeep2";
		// Edit anchored against cached: line 3 "keep2" with cached hash
		const hashKeep2 = computeLineHash(3, "keep2");
		const edits: HashlineEdit[] = [
			{
				kind: "insert",
				cursor: { kind: "after_anchor", anchor: { line: 3, hash: hashKeep2 } },
				text: "new-tail",
				lineNum: 1,
				index: 0,
			},
		];

		const { shifted, shiftCount } = tryShiftAnchors(edits, cached, current);
		// "keep2" is line 3 in cached → line 4 in current
		expect(shiftCount).toBe(1);
		// "will-change" became "MODIFIED" — can't be shifted, but not referenced in edits

		if (shifted[0].kind === "insert" && shifted[0].cursor.kind === "after_anchor") {
			expect(shifted[0].cursor.anchor.line).toBe(4);
		}
		const result = applyHashlineEdits(current, shifted);
		expect(result.lines).toBe("prefix\nkeep1\nMODIFIED\nkeep2\nnew-tail");
	});

	it("all anchors wrong → every one gets remapped via buildCorrectedEdit recovery", () => {
		const file = "line1\nline2\nline3\nline4\nline5";
		// Deliberately use wrong hashes for all anchors
		const badHash = (line: number) => `${line}aa`; // fake hash
		const diff = `≔ ${badHash(2)}..${badHash(3)}\n${pl("new2")}\n${pl("new3")}`;
		const edits = parseHashline(diff);

		try {
			applyHashlineEdits(file, edits);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const corrected = buildCorrectedEdit((err as HashlineMismatchError).remaps, diff);
			// The corrected diff should have real hashes
			expect(corrected).not.toContain("aa");
			const result = applyHashlineEdits(file, parseHashline(corrected));
			expect(result.lines).toBe("line1\nnew2\nnew3\nline4\nline5");
		}
	});

	it("recovery through remaps works for insert-after operation", () => {
		const file = "a\nb\nc";
		const wrongHash = `2${computeLineHash(2, "wrong")}`;
		const diff = `» ${wrongHash}\n${pl("new")}`;
		const edits = parseHashline(diff);

		try {
			applyHashlineEdits(file, edits);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const corrected = buildCorrectedEdit((err as HashlineMismatchError).remaps, diff);
			const result = applyHashlineEdits(file, parseHashline(corrected));
			expect(result.lines).toBe("a\nb\nnew\nc");
		}
	});

	it("multiple sections each failing and recovering independently is not possible via public API", () => {
		// This is a constraint test: buildCorrectedEdit operates on one diff at a time
		const file = "a\nb\nc";
		const wrongHash2 = `2${computeLineHash(2, "wrong")}`;
		const wrongHash3 = `3${computeLineHash(3, "wrong")}`;
		const diff1 = `» ${wrongHash2}\n${pl("x")}`;
		const diff2 = `» ${wrongHash3}\n${pl("y")}`;

		const edits1 = parseHashline(diff1);
		const edits2 = parseHashline(diff2);

		// First edit fails
		try {
			applyHashlineEdits(file, edits1);
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const corrected1 = buildCorrectedEdit((err as HashlineMismatchError).remaps, diff1);
			const result1 = applyHashlineEdits(file, parseHashline(corrected1));
			// Now we need to re-anchor for the second edit against the new file
			const result1Lines = result1.lines;
			// Second edit's anchors are stale for the new file
			try {
				applyHashlineEdits(result1Lines, edits2);
			} catch (err2) {
				expect(err2).toBeInstanceOf(HashlineMismatchError);
				const corrected2 = buildCorrectedEdit((err2 as HashlineMismatchError).remaps, diff2);
				const result2 = applyHashlineEdits(result1Lines, parseHashline(corrected2));
				expect(result2.lines).toBe("a\nb\nx\ny\nc");
			}
		}
	});
});

describe("computeLineHash consistency", () => {
	it("hash is deterministic for same line number and content", () => {
		expect(computeLineHash(1, "hello")).toBe(computeLineHash(1, "hello"));
	});

	it("hash differs for different content on same line", () => {
		expect(computeLineHash(1, "hello")).not.toBe(computeLineHash(1, "world"));
	});

	it("hash for line 1 is same as hash for line 10 with same content (content-only hash)", () => {
		// computeLineHash ignores line number; seed is fixed.
		const hash1 = computeLineHash(1, "}");
		const hash10 = computeLineHash(10, "}");
		expect(hash1).toBe(hash10);
	});

	it("hash is consistent for significant content regardless of line number", () => {
		// Lines with letters/digits use seed=0, content-only hash
		const hash1 = computeLineHash(1, "function foo() {}");
		const hash10 = computeLineHash(10, "function foo() {}");
		expect(hash1).toBe(hash10);
	});

	it("whitespace differences affect hash", () => {
		expect(computeLineHash(1, "abc")).not.toBe(computeLineHash(1, " abc"));
	});

	it("trailing whitespace is trimmed before hashing", () => {
		expect(computeLineHash(1, "abc ")).toBe(computeLineHash(1, "abc"));
	});

	it("CRLF is normalized (\\r removed) before hashing", () => {
		expect(computeLineHash(1, "abc\r")).toBe(computeLineHash(1, "abc"));
	});
});
