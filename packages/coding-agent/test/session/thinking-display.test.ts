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
	const CHUNKS = [
		"step ",
		"through the ",
		"plan:\n",
		"```js\n",
		"value += 1;\n",
		"```\n",
		"next idea\n",
		"with detail ",
		"and more.\n",
		"<!-- note\n",
	];
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

	// The forced-recompute baseline phases alone take multiple seconds
	// (quadratic work by design); run well clear of bun's 5s default timeout.
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
	}, 30000);
});

describe("formatThinkingForDisplay adversarial append detection", () => {
	// The retired spot-check detector anchored on {first byte, midpoint,
	// trailing 32-byte window}, leaving positions 1..seam-33 unchecked whenever
	// seam >= 34. Seed geometry: first newline at index 41, so seam = 42 and
	// the unchecked gap was [1, 9]. A mutation at ANY position in [1, seam)
	// must produce exactly the cold-recompute output — never a stale
	// committed prefix resumed from the unmutated seed.
	const GAP_SEED_PROSE = `I${"B".repeat(40)}\n\`\`\`\ncode\nX`;
	const GAP_SEED_RAW = `I${"B".repeat(40)}\n<!-- -->\nplain tail`;
	const POISON_GAP = "\u0000gap-poison\u0000\n<!--";
	const SEAM = 42;

	for (const proseOnly of [false, true]) {
		const seed = proseOnly ? GAP_SEED_PROSE : GAP_SEED_RAW;
		it(`mutation anywhere in [1, seam) matches cold recompute (mode=${proseOnly ? "prose" : "raw"}, incl. retired gap [1, ${SEAM - 33}])`, () => {
			for (let p = 1; p < SEAM; p++) {
				const mutant = `${seed.slice(0, p)}${seed.charAt(p) === "Z" ? "Q" : "Z"}${seed.slice(p + 1)} more`;
				formatThinkingForDisplay(POISON_GAP, proseOnly);
				const cold = formatThinkingForDisplay(mutant, proseOnly);
				formatThinkingForDisplay(POISON_GAP, proseOnly);
				formatThinkingForDisplay(seed, proseOnly);
				expect(formatThinkingForDisplay(mutant, proseOnly)).toBe(cold);
			}
		});
	}
});

describe("formatThinkingForDisplay raw identity shortcut slot hygiene", () => {
	const POISON_SHORTCUT = "\u0000shortcut-poison\u0000\n<!--";

	it("shortcut records the slot but never leaves a resumable checkpoint", () => {
		// Open fence behind an earlier newline, no comment yet: the raw
		// identity shortcut fires and records the slot.
		const base = "intro\n```\ncode line";
		// The marker then arrives inside the still-open fence: raw mode keeps
		// fence contents, but a resume from a bogus checkpoint claiming
		// "not in fence" would drop it. The cleared checkpoint forces a
		// recompute that matches the cold reference.
		const grown = `${base}\n<!-- -->`;
		formatThinkingForDisplay(POISON_SHORTCUT, false);
		const coldGrown = formatThinkingForDisplay(grown, false);
		expect(coldGrown).toContain("<!-- -->");
		formatThinkingForDisplay(POISON_SHORTCUT, false);
		formatThinkingForDisplay(base, false);
		expect(formatThinkingForDisplay(grown, false)).toBe(coldGrown);

		// An exact repeat of a shortcut text is served by the recorded memo.
		formatThinkingForDisplay(POISON_SHORTCUT, false);
		const once = formatThinkingForDisplay(base, false);
		expect(formatThinkingForDisplay(base, false)).toBe(once);
	});
});

describe("formatThinkingForDisplay seam-transition battery", () => {
	// Long no-newline prefix crossing the 8KiB resume cap, then a fence
	// transition, then multi-line appends continuing past a final newline;
	// the comment marker appears only in the tail, so raw mode hands off from
	// the identity shortcut to a folding state mid-stream. EVERY split point
	// must match the cold recompute.
	const POISON_BATTERY = "\u0000battery-poison\u0000\n<!--";

	for (const proseOnly of [false, true]) {
		it(`byte-identical at every split point across cap/fence/marker transitions (mode=${proseOnly ? "prose" : "raw"})`, () => {
			const fixture = `${"x".repeat(8300)}\n\`\`\`js\nstep one\nstep two\n\`\`\`\ntail prose.\n<!-- -->\nappended`;
			const n = fixture.length;
			const refs: string[] = new Array(n + 1);
			for (let i = 0; i <= n; i++) {
				formatThinkingForDisplay(POISON_BATTERY, proseOnly);
				refs[i] = formatThinkingForDisplay(fixture.slice(0, i), proseOnly);
			}
			formatThinkingForDisplay(POISON_BATTERY, proseOnly);
			for (let i = 1; i <= n; i++) {
				expect(formatThinkingForDisplay(fixture.slice(0, i), proseOnly)).toBe(refs[i]);
			}
		});
	}
});

describe("formatThinkingForDisplay no-newline scaling", () => {
	// Chunks deliberately never contain a newline: the seam stays at byte 0,
	// the shape that refolded the whole text every tick before the resume
	// cap. Streams here cross MAX_RESUME_PARTIAL_BYTES (8192) mid-run; later
	// ticks degrade to the identity memo / full recompute — the pre-PR
	// asymptotics for this pathological shape, bounded per call.
	const NL_FREE_CHUNKS = ["word ", "token ", "and ", "more "];
	const POISON_NL = "\u0000nl-poison\u0000\n<!--";
	const buildTexts = (ticks: number, chunk?: string) => {
		const parts: string[] = [];
		const texts: string[] = [];
		for (let i = 0; i < ticks; i++) {
			parts.push(chunk ?? NL_FREE_CHUNKS[i % NL_FREE_CHUNKS.length]!);
			texts.push(parts.join(""));
		}
		return texts;
	};

	it("growth stays cheaper than forced per-tick recompute and exact repeats stay memoized", () => {
		for (const proseOnly of [false, true]) {
			const texts = buildTexts(2400);
			const final = texts[texts.length - 1]!;
			for (const text of buildTexts(300)) {
				formatThinkingForDisplay(POISON_NL, proseOnly);
				formatThinkingForDisplay(text, proseOnly);
			}
			let sink = "";
			let t0 = performance.now();
			for (const text of texts) sink = formatThinkingForDisplay(text, proseOnly);
			const growthMs = performance.now() - t0;
			// Byte-identical through the cap transition.
			formatThinkingForDisplay(POISON_NL, proseOnly);
			expect(sink).toBe(formatThinkingForDisplay(final, proseOnly));
			// Exact-repeat burst on the final (>cap) text: pure memo hits.
			t0 = performance.now();
			for (let i = 0; i < 2000; i++) formatThinkingForDisplay(final, proseOnly);
			const repeatMs = performance.now() - t0;
			// Ratio form: memo hits cost a fraction of one growth pass —
			// robust under machine-load variance, unlike absolute bounds.
			expect(repeatMs).toBeLessThan(growthMs / 4);
			// Growth must not cost more than forcing a cold recompute per tick.
			t0 = performance.now();
			for (const text of texts) {
				formatThinkingForDisplay(POISON_NL, proseOnly);
				sink = formatThinkingForDisplay(text, proseOnly);
			}
			const baselineMs = performance.now() - t0;
			expect(growthMs).toBeLessThan(baselineMs);
		}
	});

	it("per-tick cost scales linearly with text size, not quadratically", () => {
		for (const proseOnly of [false, true]) {
			const timed = (targetBytes: number) => {
				const texts = buildTexts(1200, "z".repeat(Math.ceil(targetBytes / 1200)));
				const t0 = performance.now();
				for (const text of texts) formatThinkingForDisplay(text, proseOnly);
				return performance.now() - t0;
			};
			timed(4096); // JIT warm-up
			const smallMs = timed(12 * 1024);
			const bigMs = timed(24 * 1024);
			// Doubling the size must not quadruple the time; generous absolute
			// ceiling only guards pathological blowup (load variance is 2-3x).
			expect(bigMs).toBeLessThan(smallMs * 3.5 + 20);
			expect(bigMs).toBeLessThan(10000);
		}
	});
});

describe("formatThinkingForDisplay adversarial differential fuzz", () => {
	// Deterministic xorshift32 — no flaky randomness. Generators target the
	// two retired blind spots: mutations diverging inside the previously
	// unchecked seam-gap region, and no-newline chains long enough to cross
	// the resume cap. Every step judges the LIVE slot against a freshly
	// poisoned cold reference.
	const POISON_FUZZ = "\u0000fuzz-poison\u0000\n<!--";
	const FRAGMENTS = [
		"word ",
		"plan:\n",
		"```js\n",
		"code;\n",
		"```\n",
		"<!-- -->\n",
		"<!--\n",
		" -->\n",
		"tail.\n",
		"~~~\n",
		"`tick` ",
		"> quote\n",
		"\n",
	];
	const NL_FREE = ["word ", "token ", "and ", "-->", "<!--", "```", " . ", "Z"];

	it("gap-divergent mutations, no-newline chains, shrinks and stream switches all match cold recompute (>4000 checks)", () => {
		let s = 0x9e3779b9 | 0;
		const rnd = () => {
			s ^= s << 13;
			s ^= s >>> 17;
			s ^= s << 5;
			s |= 0;
			return (s >>> 0) / 4294967296;
		};
		const pick = (arr: string[]) => arr[Math.floor(rnd() * arr.length)]!;

		let checks = 0;
		const failures: string[] = [];
		for (let trial = 0; trial < 220; trial++) {
			for (const proseOnly of [false, true]) {
				const noNewline = trial % 3 === 0;
				let text = "";
				for (let step = 0; step < 14; step++) {
					const prev = text;
					const roll = rnd();
					if (prev.length === 0 || roll < 0.55) {
						const frag =
							noNewline && rnd() < 0.5
								? "z".repeat(600 + Math.floor(rnd() * 900))
								: pick(noNewline ? NL_FREE : FRAGMENTS);
						text = prev + frag;
					} else if (roll < 0.85 && prev.length > 2) {
						// Mutate one byte, biased into [1, seam-33] — the region
						// the retired spot-check anchors left unchecked.
						const seam = prev.lastIndexOf("\n") + 1;
						const limit = Math.max(1, Math.min(seam, prev.length) - 33);
						const p = 1 + Math.floor(rnd() * limit);
						if (p >= prev.length) text = prev + pick(FRAGMENTS);
						else text = `${prev.slice(0, p)}${prev.charAt(p) === "Z" ? "Q" : "Z"}${prev.slice(p + 1)}`;
					} else if (roll < 0.93 && prev.length > 4) {
						text = prev.slice(0, 1 + Math.floor(rnd() * (prev.length - 1)));
					} else {
						text = pick(["", "```", "<!--"]);
					}
					if (!text) continue;

					const actual = formatThinkingForDisplay(text, proseOnly);
					formatThinkingForDisplay(POISON_FUZZ, proseOnly);
					const expected = formatThinkingForDisplay(text, proseOnly);
					checks++;
					if (actual !== expected && failures.length < 5) {
						failures.push(`trial=${trial} mode=${proseOnly ? "prose" : "raw"} step=${step} len=${text.length}`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
		expect(checks).toBeGreaterThan(4000);
	});
});
