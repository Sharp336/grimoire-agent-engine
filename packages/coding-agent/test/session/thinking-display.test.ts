import { describe, expect, it } from "bun:test";
import { canonicalizeMessage, formatThinkingForDisplay } from "@oh-my-pi/pi-coding-agent/utils/thinking-display";

describe("canonicalizeMessage", () => {
	it("returns empty string for undefined, empty, or whitespace-only", () => {
		expect(canonicalizeMessage(undefined)).toBe("");
		expect(canonicalizeMessage("")).toBe("");
		expect(canonicalizeMessage("   ")).toBe("");
		expect(canonicalizeMessage("\n\n")).toBe("");
	});

	it("returns empty string for dot-only content", () => {
		expect(canonicalizeMessage(".")).toBe("");
		expect(canonicalizeMessage("...")).toBe("");
		expect(canonicalizeMessage(" . ")).toBe("");
		expect(canonicalizeMessage("\n.")).toBe("");
		expect(canonicalizeMessage("…")).toBe("");
	});

	it("returns normal canonical content for actual prose", () => {
		expect(canonicalizeMessage("hello")).toBe("hello");
		expect(canonicalizeMessage("hello.")).toBe("hello.");
		expect(canonicalizeMessage(". hello .")).toBe(". hello .");
		expect(canonicalizeMessage("a")).toBe("a");
	});
});

// Streaming fixtures: prose with comment noise, fenced code, open fences,
// tilde/backtick variants, trailing newlines, and degenerate shapes.
const STREAM_FIXTURES = [
	"hello",
	"**Headline**\n\nSome reasoning with `inline` code.\n\nAnother thought.",
	"line one\nline two\n\n\n",
	"```js\nconst x = 1;\nconsole.log(x);\n```\nafter fence",
	"```\nnever closed\nstill open",
	"intro\n```js\ncode\n```\ntail with trailing.\n",
	"Step 1.\n\n<!-- -->\nStep 2.\n",
	"Step.\n\n<!--\nmore",
	"a\nb\nc\n",
	"start ```\n```\nend",
	"```\n```",
	"~~~\ntilde fence\n~~~\n",
	"```\n\n```",
	"`x\n```y\nz",
];

describe("formatThinkingForDisplay incremental streaming", () => {
	// A text that cannot be a prefix of any fixture forces the next call to
	// take the full-recompute fallback, giving a cold-cache reference value.
	const DIRTY = "\u0000dirty\u0000\n<!--";

	for (const proseOnly of [false, true]) {
		for (const [idx, fixture] of STREAM_FIXTURES.entries()) {
			it(`byte-identical to full recompute at every split point (mode=${proseOnly ? "prose" : "raw"}, fixture ${idx})`, () => {
				const n = fixture.length;
				// Reference: cold-start full recompute for every prefix.
				const expected: string[] = [];
				for (let i = 0; i <= n; i++) {
					formatThinkingForDisplay(DIRTY, proseOnly);
					expected[i] = formatThinkingForDisplay(fixture.slice(0, i), proseOnly);
				}
				// For every split point, feed the incremental stream up to it
				// and compare every intermediate and final output.
				for (let i = 1; i <= n; i++) {
					formatThinkingForDisplay(DIRTY, proseOnly);
					for (let j = 1; j <= i; j++) {
						expect(formatThinkingForDisplay(fixture.slice(0, j), proseOnly)).toBe(expected[j]!);
					}
				}
			});
		}
	}
});
