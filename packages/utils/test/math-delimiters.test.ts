import { describe, expect, test } from "bun:test";
import {
	inlineMathSpanEnd,
	mathBlockStartIndex,
	mathStartIndex,
	tokenizeMathBlock,
	tokenizeMathSpan,
} from "../src/math-delimiters";

describe("math delimiters", () => {
	test("tokenizes dollar and bracket math spans", () => {
		expect(tokenizeMathSpan("$x^2$ tail")).toEqual({
			complete: true,
			raw: "$x^2$",
			text: "x^2",
			display: false,
		});
		expect(tokenizeMathSpan("$$x^2$$ tail")).toEqual({
			complete: true,
			raw: "$$x^2$$",
			text: "x^2",
			display: true,
		});
		expect(tokenizeMathSpan("\\(x^2\\) tail")).toEqual({
			complete: true,
			raw: "\\(x^2\\)",
			text: "x^2",
			display: false,
		});
		expect(tokenizeMathSpan("\\[x^2\\] tail")).toEqual({
			complete: true,
			raw: "\\[x^2\\]",
			text: "x^2",
			display: true,
		});
	});

	test("returns rejected dollar openers as literal spans so later math remains discoverable", () => {
		expect(tokenizeMathSpan("$20 and $30")).toEqual({ complete: false, raw: "$", display: false });
		expect(tokenizeMathSpan("$unfinished")).toEqual({ complete: false, raw: "$", display: false });
		expect(tokenizeMathSpan("$x `code` y$")).toEqual({ complete: false, raw: "$", display: false });
		expect(inlineMathSpanEnd("$cost = \\$20$", 0)).toBe(12);
		expect(mathStartIndex("cost \\$20 and \\(x\\)")).toBe(6);
	});

	test("preserves unfinished bracket openers", () => {
		expect(tokenizeMathSpan("\\(x")).toEqual({ complete: false, raw: "\\(", display: false });
		expect(tokenizeMathSpan("\\[x")).toEqual({ complete: false, raw: "\\[", display: true });
	});

	test("tokenizes own-line display blocks with up to three leading spaces", () => {
		const source = "  $$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n  $$\nnext";
		const token = tokenizeMathBlock(source);
		expect(token).toEqual({
			complete: true,
			raw: "  $$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n  $$\n",
			text: "\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}",
			display: true,
		});
		expect(mathBlockStartIndex(`prose\n${source}`)).toBe(6);
	});
});
