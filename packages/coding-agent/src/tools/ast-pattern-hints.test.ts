import { describe, expect, it } from "bun:test";
import { detectLanguageSpecificMistake, getPatternHint, inferAstLanguage } from "./ast-pattern-hints";

/**
 * The empty-match hints turn the two most common `ast_grep` mistakes — regex
 * leaking into an AST pattern, and a structurally incomplete declaration — into
 * a one-line nudge. These lock the detection contract: every regex construct is
 * caught and routed to `search`, valid patterns stay silent (no false nudge),
 * regex detection outranks the language check, and language inference only
 * commits when the extensions agree.
 */
describe("getPatternHint regex misuse", () => {
	it("flags alternation and routes to search", () => {
		const hint = getPatternHint("foo|bar", undefined);
		expect(hint).toContain("alternation");
		expect(hint).toContain("search");
	});

	it("flags wildcards, escapes, and character classes", () => {
		expect(getPatternHint("a.*b", undefined)).toContain("wildcard");
		expect(getPatternHint("foo\\w", undefined)).toContain("regex escapes");
		expect(getPatternHint("name[a-z]", undefined)).toContain("character classes");
	});

	it("stays silent for a valid AST pattern", () => {
		expect(getPatternHint("console.log($$$)", undefined)).toBeUndefined();
		expect(getPatternHint("const $X = $Y", "typescript")).toBeUndefined();
	});

	it("prefers the regex hint over the language hint", () => {
		// `foo|bar` is alternation regardless of language context.
		expect(getPatternHint("foo|bar", "python")).toContain("alternation");
	});
});

describe("getPatternHint language-specific shape", () => {
	it("flags a Python declaration with a trailing colon and shows the fix", () => {
		const hint = getPatternHint("def $F($$$):", "python");
		expect(hint).toContain("trailing colon");
		expect(hint).toContain('"def $F($$$)"');
	});

	it("flags a bare function pattern lacking params and body", () => {
		expect(detectLanguageSpecificMistake("function $NAME", "typescript")).toContain("params and a body");
		expect(detectLanguageSpecificMistake("func $NAME", "go")).toContain("params and a body");
		expect(detectLanguageSpecificMistake("fn $NAME", "rust")).toContain("params and a body");
	});

	it("stays silent without a known language or for a complete pattern", () => {
		expect(detectLanguageSpecificMistake("def $F($$$):", undefined)).toBeUndefined();
		expect(detectLanguageSpecificMistake("def $F($$$)", "python")).toBeUndefined();
	});
});

describe("inferAstLanguage", () => {
	it("resolves a single extension from globs and files", () => {
		expect(inferAstLanguage(["src/**/*.py"])).toBe("python");
		expect(inferAstLanguage(["src/worker.ts"])).toBe("typescript");
		expect(inferAstLanguage(["cmd/main.go"])).toBe("go");
	});

	it("returns undefined when extensions disagree or are absent", () => {
		expect(inferAstLanguage(["src/a.ts", "src/b.tsx"])).toBeUndefined();
		expect(inferAstLanguage(["src/"])).toBeUndefined();
		expect(inferAstLanguage([])).toBeUndefined();
	});
});
