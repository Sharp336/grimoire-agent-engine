import { describe, expect, it } from "bun:test";
import { formatThinkingForDisplay } from "@oh-my-pi/pi-coding-agent/utils/thinking-display";

// Reference reimplementation of the ORIGINAL (pre-PoC-E) full-text loop,
// without the single-slot memo — the byte-identity oracle for every prefix.
const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;

function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const trimmed = line.trim();
	return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

function referenceFormat(text: string, proseOnly: boolean): string {
	if (!text) return text;
	const hasComment = text.includes("<!--");
	const lines = text.split("\n");
	const resultLines: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;

	const FENCE = /^( {0,3})([`~]{3,})/;
	const appendEllipsis = () => {
		let lastLineIdx = resultLines.length - 1;
		while (lastLineIdx >= 0 && resultLines[lastLineIdx]!.trim() === "") {
			lastLineIdx--;
		}

		if (lastLineIdx >= 0) {
			const lastLine = resultLines[lastLineIdx]!;
			const trimmed = lastLine.trimEnd();
			if (trimmed.endsWith("...")) {
				resultLines[lastLineIdx] = trimmed;
			} else if (trimmed.endsWith(".")) {
				resultLines[lastLineIdx] = `${trimmed.slice(0, -1)}...`;
			} else {
				resultLines[lastLineIdx] = `${trimmed}...`;
			}
		} else {
			resultLines.push("...");
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		if (inFence) {
			const close = FENCE.exec(line);
			if (
				close &&
				close[2]![0] === fenceChar &&
				close[2]!.length >= fenceLen &&
				line.slice(close[1]!.length + close[2]!.length).trim() === ""
			) {
				inFence = false;
				fenceChar = "";
				fenceLen = 0;
			}
			if (!proseOnly) resultLines.push(line);
			continue;
		}

		if (hasComment && isCommentNoise(line, i === lines.length - 1)) continue;

		const open = FENCE.exec(line);
		if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				inFence = true;
				fenceChar = ch;
				fenceLen = marker.length;
				if (proseOnly) {
					appendEllipsis();
				} else {
					resultLines.push(line);
				}
				continue;
			}
		}
		resultLines.push(line);
	}

	return resultLines.join("\n");
}

// Byte-identity at EVERY prefix: feed the incremental formatter every
// char-by-char prefix of `text` (the streaming pattern) and compare against a
// fresh full re-format. Ends with one exact-repeat call (memo-hit path).
function expectByteIdenticalAcrossPrefixes(text: string, proseOnly: boolean): void {
	expect(text.length).toBeGreaterThan(0);
	for (let len = 1; len <= text.length; len++) {
		const slice = text.slice(0, len);
		expect(formatThinkingForDisplay(slice, proseOnly)).toBe(referenceFormat(slice, proseOnly));
	}
	// Exact repeat: the per-tick multi-call pattern (reveal count, slice, render).
	expect(formatThinkingForDisplay(text, proseOnly)).toBe(referenceFormat(text, proseOnly));
}

const FIXTURES: Record<string, string> = {
	// Pure prose: paragraphs, blank lines, trailing newline, no fences/comments.
	prose: "First paragraph of reasoning.\n\nSecond paragraph, still going with a sentence that ends in a period.\n\nThird paragraph without a trailing newline",
	// Prose + fences: fenced code blocks, tildes, indented fences, backtick-in-info
	// (not a fence), closing fences with trailing whitespace, unclosed tail fence.
	fences:
		"Reasoning prose.\n\n```ts\nconst x = compute(arg);\n```\n\nMore reasoning.\n\n~~~js\nlet y = 1;\n```\n\ntext with a ```code span``` marker inside prose\n\n   ```\nindented fence\n   ```\n\n```ts\nunclosed tail fence",
	// Prose + comments: gpt-5.x `<!-- -->` pads, unterminated `<!--` at the end.
	comments: "**Headline**\n\n<!-- -->\n\nBody text.\n\n<!-- -->\nMore body.\n\n<!--",
	// Prose + fence + comment: `<!--` INSIDE a fence (code, not noise), pads
	// between fence blocks, `<!--` mid-line comment content kept verbatim.
	fenceComment:
		'Para one.\n\n```\n<!-- keep me, I am code -->\nconst s = "<!--";\n```\n\n<!-- -->\n\nPara two.\n\n<!-- actual comment content -->\n\nA line with a lone `<!--` mid-line is not noise',
	// Fence as the FIRST content: prose ellipsis lands on an empty output
	// (the appendEllipsis all-blank fallback).
	blankFence: "```ts\ncode\n```\n\ntrailing prose\n",
	// Pure blank lines: every output line is empty (the hasLine bookkeeping).
	blanks: "\n\n\n",
	// Comment marker straddling a 24-char tick boundary: "<!--" split across appends.
	straddle: "Para with a comment pad: \n\n<!-- -->\n\nend",
};

describe("formatThinkingForDisplay incremental (PoC E)", () => {
	for (const [name, text] of Object.entries(FIXTURES)) {
		it(`byte-identical at every prefix: ${name} (proseOnly)`, () => {
			expectByteIdenticalAcrossPrefixes(text, true);
		});
		it(`byte-identical at every prefix: ${name} (raw)`, () => {
			expectByteIdenticalAcrossPrefixes(text, false);
		});
	}

	it("non-append rewrites (interleaved blocks) reset and stay identical", () => {
		const a = "First block text with a fence:\n\n```\ncode\n```\n";
		const b = "Second block, no fence, with a pad:\n\n<!-- -->\n";
		for (const proseOnly of [true, false]) {
			// A stream, then B stream, then A continues — the slot must reset and
			// re-derive A's full state, then keep incrementing.
			expect(formatThinkingForDisplay(a, proseOnly)).toBe(referenceFormat(a, proseOnly));
			expect(formatThinkingForDisplay(b, proseOnly)).toBe(referenceFormat(b, proseOnly));
			expect(formatThinkingForDisplay(`${a}appended`, proseOnly)).toBe(referenceFormat(`${a}appended`, proseOnly));
		}
	});

	it("same-length different text resets (does not misread as append)", () => {
		const a = "aaaa";
		const b = "bbbb";
		expect(formatThinkingForDisplay(a, true)).toBe(referenceFormat(a, true));
		expect(formatThinkingForDisplay(b, true)).toBe(referenceFormat(b, true));
		expect(formatThinkingForDisplay(`${b} extra`, true)).toBe(referenceFormat(`${b} extra`, true));
	});
	it("longer non-append rewrite must not take the prose identity fast path", () => {
		// "abc" formats to itself via the identity fast path; the next call
		// formats an unrelated, LONGER text whose newline lies before the
		// cached length. Without an append-prefix verification the identity
		// verdict would pass and return the raw text, skipping the fence
		// ellipsis the full formatter applies.
		const a = "abc";
		const b = "x\n```";
		expect(formatThinkingForDisplay(a, true)).toBe(referenceFormat(a, true));
		expect(formatThinkingForDisplay(b, true)).toBe(referenceFormat(b, true));
	});

	it("raw mode with comments vs without: identity then real formatting", () => {
		// No comments at all → identity (the fast path), byte-identical.
		expect(formatThinkingForDisplay("plain raw prose, no markers", false)).toBe(
			referenceFormat("plain raw prose, no markers", false),
		);
		// First comment appears: the slot transitions from identity bookkeeping
		// to full line state; the resulting output must match a full re-format.
		expect(formatThinkingForDisplay("line one\n\n<!-- -->\n\nline two", false)).toBe(
			referenceFormat("line one\n\n<!-- -->\n\nline two", false),
		);
		// And it keeps incrementing afterwards.
		expect(formatThinkingForDisplay("line one\n\n<!-- -->\n\nline two\n\nline three", false)).toBe(
			referenceFormat("line one\n\n<!-- -->\n\nline two\n\nline three", false),
		);
	});

	it("empty text passes through", () => {
		expect(formatThinkingForDisplay("", true)).toBe("");
		expect(formatThinkingForDisplay("", false)).toBe("");
	});

	it("exact-repeat returns the identical string value", () => {
		const text = "**Headline**\n\n<!-- -->\n\nBody with ```code``` inline.\n";
		const first = formatThinkingForDisplay(text, true);
		const second = formatThinkingForDisplay(text, true);
		expect(second).toBe(first);
		expect(second).toBe(referenceFormat(text, true));
	});
});
