import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { advanceGlowPhase, resetGlowPhase } from "@oh-my-pi/pi-coding-agent/modes/gradient-highlight";
import { highlightMagicKeywords } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	// Gradient palettes read the active theme's color mode.
	await initTheme(false);
});

describe("highlightMagicKeywords", () => {
	it("paints every magic keyword in a single prose pass, preserving visible text", () => {
		const input = "first ultrathink then orchestrate the workflowz";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[38");
		expect(Bun.stripANSI(decorated)).toBe(input);
		// Each keyword is gradient-painted character-by-character, so none survives as a
		// contiguous run in the decorated output.
		for (const keyword of ["ultrathink", "orchestrate", "workflowz"]) {
			expect(decorated).not.toContain(keyword);
			expect(Bun.stripANSI(decorated)).toContain(keyword);
		}
	});

	it("never paints keywords inside code spans, fenced blocks, or XML sections", () => {
		const input = "`ultrathink`\n```\norchestrate\n```\n<x>workflowz</x>";
		expect(highlightMagicKeywords(input)).toBe(input);
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

describe("glow shimmer phase", () => {
	afterEach(() => {
		// Shared module-level phase: never leak a non-idle phase into the static-gradient tests.
		resetGlowPhase();
	});

	it("rotates the gradient with phase, preserving visible text and width, and restores idle bytes on reset", () => {
		const input = "please ultrathink now";
		const frame0 = highlightMagicKeywords(input);

		advanceGlowPhase();
		const frame1 = highlightMagicKeywords(input);

		// Shimmer: the per-character stop indices shift, so the SGR byte stream changes…
		expect(frame1).not.toBe(frame0);
		// …but the visible text and its width are untouched (decoration is zero-width).
		expect(Bun.stripANSI(frame1)).toBe(input);
		expect(Bun.stringWidth(Bun.stripANSI(frame1))).toBe(Bun.stringWidth(input));

		// Idle (phase 0) output is byte-identical to the pre-animation gradient.
		resetGlowPhase();
		expect(highlightMagicKeywords(input)).toBe(frame0);
	});
});
