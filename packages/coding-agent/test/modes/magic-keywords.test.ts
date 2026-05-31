import { beforeAll, describe, expect, it } from "bun:test";
import { highlightMagicKeywords } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	// Gradient palettes read the active theme's color mode.
	await initTheme(false);
});

describe("highlightMagicKeywords", () => {
	it("paints default-enabled magic keywords in a single prose pass, preserving visible text", () => {
		const input = "first ultrathink then orchestrate the workflow";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[38");
		expect(Bun.stripANSI(decorated)).toBe(input);
		for (const keyword of ["ultrathink", "orchestrate"]) {
			expect(decorated).not.toContain(keyword);
			expect(Bun.stripANSI(decorated)).toContain(keyword);
		}
		expect(decorated).toContain("workflow");
	});

	it("paints workflow only when the workflow mode is enabled", () => {
		const input = "/workflow audit";
		expect(highlightMagicKeywords(input)).toBe(input);
		const decorated = highlightMagicKeywords(input, undefined, { workflowEnabled: true });
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
		expect(decorated).not.toContain("/workflow");
	});

	it("never paints keywords inside code spans, fenced blocks, or XML sections", () => {
		const input = "`ultrathink`\n```\norchestrate\n```\n<x>/workflow</x>";
		expect(highlightMagicKeywords(input, undefined, { workflowEnabled: true })).toBe(input);
	});

	it("paints only the prose occurrence when the keyword also appears in code", () => {
		const decorated = highlightMagicKeywords("`orchestrate` but please orchestrate now");
		// The code-span occurrence stays literal; the prose one is split by gradient escapes.
		expect(decorated).toContain("`orchestrate`");
		expect(Bun.stripANSI(decorated)).toBe("`orchestrate` but please orchestrate now");
		// Exactly one prose occurrence painted ⇒ one contiguous "orchestrate" remains (the code one).
		expect(decorated.split("orchestrate").length - 1).toBe(1);
	});

	it("restores the supplied foreground after each painted keyword", () => {
		const reset = "\x1b[38;2;1;2;3m";
		const decorated = highlightMagicKeywords("go orchestrate go", reset);
		expect(decorated).toContain(reset);
		// The reset must land before the trailing prose so it keeps the bubble color.
		expect(decorated.endsWith(`${reset} go`)).toBe(true);
	});
});
