import { describe, expect, it } from "bun:test";
import { decodeUnicodeEscapes, decodeUnicodeEscapesInDiffAdditions } from "@oh-my-pi/pi-coding-agent/edit";

describe("decodeUnicodeEscapes", () => {
	it("decodes a single \\uXXXX sequence to the Unicode character", () => {
		// \u2192 (right arrow) as literal 6-char escape should become →
		expect(decodeUnicodeEscapes("hello \\u2192 world")).toBe("hello \u2192 world");
	});

	it("decodes multiple sequences in one string", () => {
		expect(decodeUnicodeEscapes("\\u0041\\u0042\\u0043")).toBe("ABC");
	});

	it("decodes case-insensitive hex digits", () => {
		expect(decodeUnicodeEscapes("\\u00E9")).toBe("\u00e9"); // é
		expect(decodeUnicodeEscapes("\\u00e9")).toBe("\u00e9"); // é
	});

	it("leaves strings without escape sequences unchanged", () => {
		const s = "hello world";
		expect(decodeUnicodeEscapes(s)).toBe(s);
	});

	it("leaves already-decoded Unicode characters unchanged", () => {
		// actual arrow character, not escape notation
		const s = "hello \u2192 world";
		expect(decodeUnicodeEscapes(s)).toBe(s);
	});

	it("does not decode \\uXXX with fewer than 4 hex digits", () => {
		const s = "\\u219";
		expect(decodeUnicodeEscapes(s)).toBe(s);
	});

	it("does not decode \\uXXXX preceded by another backslash (intentional literal)", () => {
		// \\u2192 in the parsed string means the model used \\\\u2192 in JSON
		expect(decodeUnicodeEscapes("\\\\u2192")).toBe("\\\\u2192");
	});

	it("handles empty string", () => {
		expect(decodeUnicodeEscapes("")).toBe("");
	});
});

describe("decodeUnicodeEscapesInDiffAdditions", () => {
	it("decodes \\uXXXX in addition lines only", () => {
		const diff = [
			"--- a/file.ts",
			"+++ b/file.ts",
			"@@ -1,3 +1,3 @@",
			' const x = "\\u2192";', // context line — must not be decoded
			'-const y = "\\u2190";', // removal line — must not be decoded
			'+const y = "\\u21d2";', // addition line — must be decoded
		].join("\n");
		const result = decodeUnicodeEscapesInDiffAdditions(diff);
		const lines = result.split("\n");
		// context line unchanged
		expect(lines[3]).toBe(' const x = "\\u2192";');
		// removal line unchanged
		expect(lines[4]).toBe('-const y = "\\u2190";');
		// addition line decoded
		expect(lines[5]).toBe('+const y = "\u21d2";');
	});

	it("leaves +++ file headers unchanged", () => {
		const diff = '+++ b/src/file.ts\n+const x = "\\u2192";\n';
		const lines = decodeUnicodeEscapesInDiffAdditions(diff).split("\n");
		expect(lines[0]).toBe("+++ b/src/file.ts");
		expect(lines[1]).toBe('+const x = "\u2192";');
	});

	it("decodes addition lines whose content starts with +++", () => {
		// A line in source that literally starts with "+++" is an addition: "++++...";
		// the old "+++" guard (no trailing space) would have skipped this.
		const diff = "++++\\u2192 marker";
		expect(decodeUnicodeEscapesInDiffAdditions(diff)).toBe("++++→ marker");
	});

	it("does not decode raw-text (no-prefix) lines — handled upstream for create op", () => {
		// create-op content may have no "+" prefix; decodeUnicodeEscapesInDiffAdditions
		// intentionally leaves those lines alone. The caller (patch.ts) uses
		// decodeUnicodeEscapes directly for op=\"create\".
		const raw = 'const x = "\\u2192";';
		expect(decodeUnicodeEscapesInDiffAdditions(raw)).toBe(raw);
	});

	it("handles empty diff", () => {
		expect(decodeUnicodeEscapesInDiffAdditions("")).toBe("");
	});
});
