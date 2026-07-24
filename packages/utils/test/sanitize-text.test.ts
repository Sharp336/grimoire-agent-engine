import { describe, expect, it } from "bun:test";
import { escapeUnpairedSurrogates, sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";

describe("sanitizeText", () => {
	it("strips ANSI CSI and removes C0/C1 control chars while keeping tab + LF", () => {
		const input = "\x1b[31mred\x1b[0m\ra\u0000b\tline\ncarriage\r\u0001\u0085";
		expect(sanitizeText(input)).toBe("redab\tline\ncarriage");
	});

	it("drops lone surrogates and preserves valid surrogate pairs", () => {
		expect(sanitizeText(`a\ud800b\udc00c`)).toBe("abc");
		const validPair = "a\u{1f600}b";
		expect(sanitizeText(validPair)).toBe(validPair);
	});

	it("drops replacement characters on malformed input", () => {
		expect(sanitizeText("a\ud800�b")).toBe("ab");
	});

	it("preserves replacement characters on well-formed input", () => {
		expect(sanitizeText("a�b")).toBe("a�b");
	});

	it("preserves valid surrogate pairs while stripping controls", () => {
		const validPair = "\u{1f600}";
		expect(sanitizeText(`a${validPair}\u0000b`)).toBe(`a${validPair}b`);
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(sanitizeText("\x1b]0;title\x07hello")).toBe("hello");
	});

	it("strips OSC sequences terminated by ST (ESC \\)", () => {
		expect(sanitizeText("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\!")).toBe("link!");
	});

	it("returns the original string instance when no changes are needed", () => {
		const clean = "plain ascii\twith\ttabs\nand newlines";
		expect(sanitizeText(clean)).toBe(clean);
	});

	it("strips DCS sequences terminated by ST", () => {
		expect(sanitizeText("before\x1bPpayload\x1b\\after")).toBe("beforeafter");
	});

	it("handles single-byte ESC finals (e.g. ESC c reset)", () => {
		expect(sanitizeText("a\x1bcb")).toBe("ab");
	});

	it("strips DEL and normalizes lone CR", () => {
		expect(sanitizeText("a\x7fb\rc")).toBe("abc");
	});
});

describe("escapeUnpairedSurrogates", () => {
	it("preserves valid Unicode and returns the original string on the fast path", () => {
		const values = [
			"한",
			"한",
			"ㅎㅏㄴ",
			"😀",
			"A😀B",
			String.fromCharCode(0xd83d, 0xde00),
			String.raw`literal \uD800`,
			"�",
		];
		for (const value of values) {
			const escaped = escapeUnpairedSurrogates(value);
			expect(escaped.text).toBe(value);
			expect(escaped.escapedCodeUnits).toBe(0);
		}
	});

	it("escapes each unmatched UTF-16 surrogate with uppercase hex", () => {
		const cases: Array<[string, string, number]> = [
			["a\ud800b", String.raw`a\uD800b`, 1],
			["a\udc00b", String.raw`a\uDC00b`, 1],
			["\ud800\ud800\udc00", `${String.raw`\uD800`}𐀀`, 1],
			["\udc00\ud800\udc00", `${String.raw`\uDC00`}𐀀`, 1],
			["\ud800x\udc00y\udfff", String.raw`\uD800x\uDC00y\uDFFF`, 3],
		];
		for (const [input, expected, count] of cases) {
			expect(escapeUnpairedSurrogates(input)).toEqual({ text: expected, escapedCodeUnits: count });
		}
	});

	it("is idempotent", () => {
		const once = escapeUnpairedSurrogates("a\ud800b\udc00c");
		expect(escapeUnpairedSurrogates(once.text)).toEqual({ text: once.text, escapedCodeUnits: 0 });
	});
});
