import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

// B+ fast-tail contract: when a transient streaming frame's last content row
// came from a paragraph, an append-only same-line delta re-renders ONLY that
// row (splice of the re-wrapped grown row onto the previous frame's rows)
// instead of re-lexing the whole tail. The observable contract is BYTE
// IDENTITY with a cold full render at EVERY frame (the new text shows every
// frame — no B-style lag) plus correct disarming on style/structural hazards
// and reset on finalize/width/flip transitions. These tests encode that
// matrix; the adversarial seam cases (URL/entity/swatch/ref-def/OSC) are
// covered by the differential smoke harness.

const THEME = defaultMarkdownTheme;

function renderCold(text: string, width: number): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, THEME).render(width);
	clearRenderCache();
	return out;
}

/** Reveal `full` in `step`-char increments through ONE reused transient
 *  (streaming) instance; assert EVERY frame is byte-identical to a cold full
 *  render of the same prefix (byte identity = the new text is visible — no
 *  lag). The streaming instance must go through its own incremental path
 *  every step, so the cold oracle always re-lexes. */
function assertNoLag(full: string, width = 60, step = 1): void {
	const streaming = new Markdown("", 0, 0, THEME);
	streaming.transientRenderCache = true;
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		const got = streaming.render(width);
		expect(got).toEqual(renderCold(slice, width));
	}
	clearRenderCache();
	streaming.setText(full);
	expect(streaming.render(width)).toEqual(renderCold(full, width));
}

describe("B+ fast-tail paragraph re-wrap", () => {
	it("prose reveal shows new text every frame (no lag)", () => {
		// Inert prose deltas with no style markers: the fast path re-wraps the
		// growing last row every frame.
		assertNoLag(
			"This is a plain prose paragraph that streams in one character at a time without any markdown styling markers.",
			60,
			1,
		);
	});

	it("run-level default style disarms fast path (single ANSI run contract)", () => {
		// With a run-level defaultTextStyle (color/italic — as streamed
		// thinking and colored assistant content use), a splice would
		// concatenate a pre-styled row with a separately styled delta: two
		// ANSI runs where a cold render produces one. The fast path must not
		// engage — every frame stays byte-identical to cold.
		const full = "a styled streaming paragraph grows one character at a time";
		const style = { color: (t: string) => `\x1b[35m${t}\x1b[39m`, italic: true };
		const styledCold = (text: string, width: number): readonly string[] => {
			clearRenderCache();
			const out = new Markdown(text, 0, 0, THEME, style).render(width);
			clearRenderCache();
			return out;
		};
		const streaming = new Markdown("", 0, 0, THEME, style);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 1) {
			const slice = full.slice(0, len);
			clearRenderCache();
			streaming.setText(slice);
			expect(streaming.render(60)).toEqual(styledCold(slice, 60));
		}
	});

	it("intraword underscore deltas stay on the fast path (narrowed gate)", () => {
		// `_` inside a word is literal per CommonMark flanking rules — the
		// delta `_` must NOT force a full re-lex every frame; the grown row
		// re-wraps with the literal underscore byte-identical to cold.
		assertNoLag("measure the raw_word_delta against the baseline at every frame", 60, 1);
	});

	it("open emphasis closed by a later delta re-lexes the grown row", () => {
		// A row holding an OPEN `*` disarms any marker delta; the closing `*`
		// frame re-lexes so the whole span renders styled, not as a stale
		// literal row.
		assertNoLag("the *whole span* must render emphasized, not stale", 60, 1);
	});

	it("paragraph completing into a list marker disarms (line-start hazard)", () => {
		// `abc\n1. item` lexes as paragraph + LIST, not one paragraph — the
		// grown-line start check must disarm so the splice never renders the
		// list as paragraph text.
		assertNoLag("abc\n1. item", 60, 1);
	});

	it("finalize after fast-path frames is byte-identical to cold", () => {
		const full = "finalizing a streaming paragraph must match the cold render exactly";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 3) {
			clearRenderCache();
			streaming.setText(full.slice(0, len));
			streaming.render(60);
		}
		streaming.transientRenderCache = false;
		clearRenderCache();
		streaming.setText(full);
		expect(streaming.render(60)).toEqual(renderCold(full, 60));
	});

	it("width change after fast-path frames re-lexes at new width", () => {
		const full = "a streamed paragraph that must reflow cleanly when the terminal width changes mid-stream";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 3) {
			clearRenderCache();
			streaming.setText(full.slice(0, len));
			streaming.render(80);
		}
		clearRenderCache();
		streaming.setText(full);
		expect(streaming.render(40)).toEqual(renderCold(full, 40));
	});

	it("first frame is cold (no fast path)", () => {
		const fresh = new Markdown("hello world", 0, 0, THEME);
		fresh.transientRenderCache = true;
		clearRenderCache();
		expect(fresh.render(60)).toEqual(renderCold("hello world", 60));
	});

	it("overflow long word re-wraps identically (break_long_word parity)", () => {
		assertNoLag("A verylongwordthatcannotfitwithintherowwidthandmustbesplitbysomeheuristicacrossthelines", 40, 1);
	});

	it("CRLF delta disarms fast path", () => {
		const full = "first line\r\nsecond line";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 1) {
			const slice = full.slice(0, len);
			clearRenderCache();
			streaming.setText(slice);
			expect(streaming.render(60)).toEqual(renderCold(slice, 60));
		}
	});

	it("transientRenderCache flip mid-stream drops fast path", () => {
		const full = "flipping transient off and back on must never serve a stale fast-path row";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 3) {
			clearRenderCache();
			streaming.setText(full.slice(0, len));
			streaming.render(60);
		}
		streaming.transientRenderCache = false;
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText(full);
		expect(streaming.render(60)).toEqual(renderCold(full, 60));
	});
});
