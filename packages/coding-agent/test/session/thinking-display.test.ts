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

describe("formatThinkingForDisplay streaming performance", () => {
	// ~10 bytes/tick mixing prose, newlines, fences, and a comment marker so
	// both modes exercise the fold path rather than a shortcut.
	const CHUNKS = ["step ", "through the ", "plan:\n", "```js\n", "value += 1;\n", "```\n", "next idea\n", "with detail ", "and more.\n", "<!-- note\n"];
	const TICKS = 5000;
	const texts: string[] = [];
	{
		// Monotonically growing stream; joined per tick so fixtures are flat
		// strings and timing measures the formatter rather than lazy rope
		// flattening of `+=`-accumulated fixtures.
		const parts: string[] = [];
		for (let i = 0; i < TICKS; i++) {
			parts.push(CHUNKS[i % CHUNKS.length]!);
			texts.push(parts.join(""));
		}
	}
	// Carries `<!--` so the raw-mode identity shortcut cannot skip poisoning
	// the cache between timed calls.
	const DIRTY_PERF = "\u0000perf-dirty\u0000\n<!--";

	it(`incremental append stream beats per-tick recompute over ${TICKS} ticks (raw + prose)`, () => {
		for (const proseOnly of [false, true]) {
			// JIT warm-up on a shorter prefix of the same stream.
			for (let i = 0; i < 500; i++) {
				formatThinkingForDisplay(DIRTY_PERF, proseOnly);
				formatThinkingForDisplay(texts[i]!, proseOnly);
			}
			let sink = "";
			let t0 = performance.now();
			for (const text of texts) sink = formatThinkingForDisplay(text, proseOnly);
			const incrementalMs = performance.now() - t0;
			// The streamed result must match one cold recompute of the full text.
			formatThinkingForDisplay(DIRTY_PERF, proseOnly);
			expect(sink).toBe(formatThinkingForDisplay(texts[TICKS - 1]!, proseOnly));
			// Pre-PR baseline: a forced full re-scan per tick.
			t0 = performance.now();
			for (const text of texts) {
				formatThinkingForDisplay(DIRTY_PERF, proseOnly);
				sink = formatThinkingForDisplay(text, proseOnly);
			}
			const recomputeMs = performance.now() - t0;
			expect(incrementalMs).toBeLessThan(recomputeMs / 2);
			expect(incrementalMs).toBeLessThan(2000);
		}
	});
});
