export interface CompleteMathSpan {
	complete: true;
	raw: string;
	text: string;
	display: boolean;
}

export interface IncompleteMathSpan {
	complete: false;
	raw: string;
	display: boolean;
}

export type MathSpan = CompleteMathSpan | IncompleteMathSpan;

interface MathDelimiter {
	open: string;
	close: string;
	display: boolean;
}

const DELIMITERS: readonly MathDelimiter[] = [
	{ open: "$$", close: "$$", display: true },
	{ open: "\\[", close: "\\]", display: true },
	{ open: "\\(", close: "\\)", display: false },
	{ open: "$", close: "$", display: false },
];
const MATH_BLOCK_DOLLAR = /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n {0,3}\$\$[ \t]*(?:\n|$)/;
const MATH_BLOCK_BRACKET = /^ {0,3}\\\[[ \t]*\n([\s\S]+?)\n {0,3}\\\][ \t]*(?:\n|$)/;
const MATH_BLOCK_START = /(?:^|\n) {0,3}(?:\$\$|\\\[)[ \t]*\n/;

function isEscaped(source: string, index: number): boolean {
	let slashCount = 0;
	for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) slashCount++;
	return slashCount % 2 === 1;
}

export function mathStartIndex(source: string): number | undefined {
	let next = source.indexOf("$");
	const paren = source.indexOf("\\(");
	if (paren !== -1 && (next === -1 || paren < next)) next = paren;
	const bracket = source.indexOf("\\[");
	if (bracket !== -1 && (next === -1 || bracket < next)) next = bracket;
	return next === -1 ? undefined : next;
}

/**
 * Index of the `$` that closes an inline math span opened at `open`, or -1.
 * Uses Pandoc's anti-currency rules and never crosses a newline.
 */
export function inlineMathSpanEnd(source: string, open: number): number {
	const after = source[open + 1];
	if (after === undefined || after === " " || after === "\t" || after === "\n" || after === "$") return -1;
	for (let at = open + 1; at < source.length; at++) {
		const char = source[at];
		if (char === "\\") {
			at++;
			continue;
		}
		if (char === "\n") return -1;
		if (char !== "$") continue;
		const before = source[at - 1];
		if (before === " " || before === "\t") return -1;
		const next = source[at + 1];
		if (next !== undefined && next >= "0" && next <= "9") continue;
		return source.slice(open + 1, at).trim().length > 0 ? at : -1;
	}
	return -1;
}

function closingDelimiterIndex(source: string, { open, close, display }: MathDelimiter): number {
	for (let at = source.indexOf(close, open.length); at !== -1; at = source.indexOf(close, at + 1)) {
		const touchesDollar = close.startsWith("$") && (source[at - 1] === "$" || source[at + close.length] === "$");
		if (isEscaped(source, at) || touchesDollar) continue;
		return !display && source.slice(open.length, at).includes("\n") ? -1 : at;
	}
	return -1;
}

/** Tokenize one math span at the start of source. */
export function tokenizeMathSpan(source: string): MathSpan | undefined {
	for (const delimiter of DELIMITERS) {
		if (!source.startsWith(delimiter.open)) continue;
		if (delimiter.open === "$") {
			const closeAt = inlineMathSpanEnd(source, 0);
			if (closeAt === -1) return { complete: false, raw: "$", display: false };
			const text = source.slice(1, closeAt);
			if (text.includes("`")) return { complete: false, raw: "$", display: false };
			return { complete: true, raw: source.slice(0, closeAt + 1), text, display: false };
		}
		if (delimiter.open.startsWith("$") && source[delimiter.open.length] === "$") return undefined;

		const closeAt = closingDelimiterIndex(source, delimiter);
		if (closeAt === -1) {
			if (delimiter.open.startsWith("\\"))
				return { complete: false, raw: delimiter.open, display: delimiter.display };
			return undefined;
		}
		const text = source.slice(delimiter.open.length, closeAt);
		if (text.trim() === "" || text.includes("`")) return undefined;
		return {
			complete: true,
			raw: source.slice(0, closeAt + delimiter.close.length),
			text: text.trim(),
			display: delimiter.display,
		};
	}
	return undefined;
}

/** Character index of the next own-line display-math opener. */
export function mathBlockStartIndex(source: string): number | undefined {
	const match = MATH_BLOCK_START.exec(source);
	if (!match) return undefined;
	return match.index === 0 ? 0 : match.index + 1;
}

/** Tokenize an own-line display-math block at the start of source. */
export function tokenizeMathBlock(source: string): CompleteMathSpan | undefined {
	const match = MATH_BLOCK_DOLLAR.exec(source) ?? MATH_BLOCK_BRACKET.exec(source);
	if (!match || match[1].trim().length === 0) return undefined;
	return { complete: true, raw: match[0], text: match[1], display: true };
}
