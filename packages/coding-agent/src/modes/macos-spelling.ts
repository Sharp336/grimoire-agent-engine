import * as native from "@oh-my-pi/pi-natives";
import type {
	EditorInlineReplacement,
	EditorTextAssistProvider,
	EditorWordReplacements,
} from "@oh-my-pi/pi-tui/components/editor";
import { logger } from "@oh-my-pi/pi-utils";
import { maskNonProse } from "./markdown-prose";

const TYPO_START = "\x1b[4:3m\x1b[58:2::255:95:95m";
const TYPO_END = "\x1b[4:0m\x1b[59m";
const WORD_SUFFIX = /[\p{L}\p{M}']+$/u;
const COMPLETED_WORD = /([\p{L}\p{M}']+)([\s.,;:!?"\])}])$/u;
const CODEISH_CHARACTERS = "\\/@_=:{}[]<>";
const CAMEL_CASE = /\p{Ll}\p{Lu}/u;
const CACHE_LIMIT = 256;
const MAX_SPELLING_BUFFER_LENGTH = 20_000;
const MAX_SPELLING_LINE_LENGTH = 1_000;
const WORD_BOUNDARY = /[\s.,;:!?"\])}]/u;

/** Independently switchable macOS prose-assistance features. */
export interface SpellingFeatures {
	typoDetection: boolean;
	autocomplete: boolean;
	autocorrect: boolean;
}

/** Logical source location for one rendered editor segment. */
export interface SpellingDecorationContext {
	editorText: string;
	lines: readonly string[];
	line: number;
	startCol: number;
}

/** Native spelling operations used by {@link MacOSSpellingProvider}. */
export interface SpellingBackend {
	isAvailable(): boolean;
	checkSpelling(text: string): readonly native.SpellingRange[];
	completeWord(text: string, start: number, length: number): readonly string[];
	autocorrectWord(text: string, start: number, length: number): string | null;
	spellingGuesses(text: string, start: number, length: number): readonly string[];
}

const NATIVE_BACKEND: SpellingBackend = {
	isAvailable: () =>
		typeof native.macOSSpellCheckerAvailable === "function" &&
		typeof native.macOSCheckSpelling === "function" &&
		typeof native.macOSCompleteWord === "function" &&
		typeof native.macOSAutocorrectWord === "function" &&
		typeof native.macOSSpellingGuesses === "function" &&
		native.macOSSpellCheckerAvailable(),
	checkSpelling: text => native.macOSCheckSpelling(text),
	completeWord: (text, start, length) => native.macOSCompleteWord(text, start, length),
	autocorrectWord: (text, start, length) => native.macOSAutocorrectWord(text, start, length),
	spellingGuesses: (text, start, length) => native.macOSSpellingGuesses(text, start, length),
};

function tokenAt(text: string, start: number, end: number): string {
	let tokenStart = start;
	while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) tokenStart--;
	let tokenEnd = end;
	while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) tokenEnd++;
	return text.slice(tokenStart, tokenEnd);
}

function isProseWord(text: string, masked: string, start: number, end: number): boolean {
	if (start < 0 || end <= start || end > text.length) return false;
	if (masked.slice(start, end).trim().length === 0) return false;
	const token = tokenAt(text, start, end);
	for (const char of token) {
		if (CODEISH_CHARACTERS.includes(char)) return false;
	}
	if (CAMEL_CASE.test(token) || /\d/.test(token)) return false;
	return !text.trimStart().startsWith("/") && !text.startsWith("->") && !text.startsWith("=>");
}

/**
 * Bridges Apple's spelling service into the editor's separate typo,
 * word-completion, and autocorrection paths.
 */
export class MacOSSpellingProvider implements EditorTextAssistProvider {
	#features: SpellingFeatures = { typoDetection: false, autocomplete: false, autocorrect: false };
	#available: boolean;
	#availabilityChecked = false;
	#typoCache = new Map<string, readonly native.SpellingRange[]>();
	#sourceText = "";
	#sourceMask = "";
	#sourceLineOffsets: number[] = [];

	constructor(private readonly backend: SpellingBackend = NATIVE_BACKEND) {
		this.#available = false;
	}

	/** Apply all three independent feature gates and invalidate rendered typo ranges. */
	setFeatures(features: SpellingFeatures): void {
		if (
			this.#features.typoDetection === features.typoDetection &&
			this.#features.autocomplete === features.autocomplete &&
			this.#features.autocorrect === features.autocorrect
		) {
			return;
		}
		this.#features = { ...features };
		if (!this.#availabilityChecked && (features.typoDetection || features.autocomplete || features.autocorrect)) {
			this.#availabilityChecked = true;
			this.#available = typeof this.backend.isAvailable === "function" && this.backend.isAvailable();
		}
		this.#typoCache.clear();
	}

	/** Add red undercurls to misspellings while preserving visible text width. */
	decorateTypos(
		text: string,
		context: SpellingDecorationContext,
		decorate: (span: string) => string = value => value,
	): string {
		if (!this.#available || !this.#features.typoDetection || text.length === 0) return decorate(text);
		if (!this.#sourceRangeIsProse(context, context.startCol, context.startCol + text.length)) {
			return decorate(text);
		}
		const ranges = this.#getTypoRanges(text);
		if (ranges.length === 0) return decorate(text);
		let rendered = "";
		let cursor = 0;
		for (const range of ranges) {
			const end = range.start + range.length;
			if (!this.#sourceRangeIsProse(context, context.startCol + range.start, context.startCol + end)) {
				continue;
			}
			rendered += decorate(text.slice(cursor, range.start));
			rendered += TYPO_START + decorate(text.slice(range.start, end)) + TYPO_END;
			cursor = end;
		}
		return rendered + decorate(text.slice(cursor));
	}

	/** Return the macOS completion suffix for the word ending at the cursor. */
	getWordCompletion(lines: string[], cursorLine: number, cursorCol: number): string | null {
		if (!this.#available || !this.#features.autocomplete) return null;
		const line = lines[cursorLine] ?? "";
		if (/^[\p{L}\p{M}']/u.test(line.slice(cursorCol))) return null;
		const match = WORD_SUFFIX.exec(line.slice(0, cursorCol));
		if (!match || match[0].length < 2) return null;
		const start = cursorCol - match[0].length;
		const masked = maskNonProse(line);
		if (!isProseWord(line, masked, start, cursorCol)) return null;
		const context = this.#context(lines, cursorLine);
		if (!this.#sourceRangeIsProse(context, start, cursorCol)) return null;
		const prefix = match[0];
		const lowerPrefix = prefix.toLocaleLowerCase();
		try {
			for (const completion of this.backend.completeWord(line, start, prefix.length)) {
				if (completion.length > prefix.length && completion.toLocaleLowerCase().startsWith(lowerPrefix)) {
					return completion.slice(prefix.length);
				}
			}
		} catch (error) {
			this.#disable(error);
		}
		return null;
	}

	/** Return the confident macOS correction after a completed prose word. */
	tryAutocorrect(lines: string[], cursorLine: number, cursorCol: number): EditorInlineReplacement | null {
		if (!this.#available || !this.#features.autocorrect) return null;
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const match = COMPLETED_WORD.exec(textBeforeCursor);
		if (!match) return null;
		const word = match[1] ?? "";
		const boundary = match[2] ?? "";
		const start = match.index;
		const masked = maskNonProse(textBeforeCursor);
		if (!isProseWord(textBeforeCursor, masked, start, start + word.length)) return null;
		const context = this.#context(lines, cursorLine);
		if (!this.#sourceRangeIsProse(context, start, start + word.length)) return null;
		try {
			const correction = this.backend.autocorrectWord(textBeforeCursor, start, word.length);
			if (!correction || correction === word) return null;
			return { replaceLen: word.length + boundary.length, insert: correction + boundary };
		} catch (error) {
			this.#disable(error);
			return null;
		}
	}

	/** Return macOS replacement guesses for the misspelled word at the cursor. */
	getWordReplacements(lines: string[], cursorLine: number, cursorCol: number): EditorWordReplacements | null {
		if (!this.#available || !this.#features.typoDetection) return null;

		const line = lines[cursorLine] ?? "";
		const context = this.#context(lines, cursorLine);
		if (!this.#sourceRangeIsProse(context, 0, line.length)) return null;
		const range = this.#getTypoRanges(line).find(candidate => {
			const end = candidate.start + candidate.length;
			return (
				cursorCol >= candidate.start &&
				(cursorCol <= end || (cursorCol === end + 1 && WORD_BOUNDARY.test(line[end] ?? ""))) &&
				this.#sourceRangeIsProse(context, candidate.start, end)
			);
		});
		if (!range) return null;
		try {
			const seen = new Set<string>();
			const items: string[] = [];
			for (const guess of this.backend.spellingGuesses(line, range.start, range.length)) {
				if (!guess || seen.has(guess)) continue;
				seen.add(guess);
				items.push(guess);
				if (items.length === 10) break;
			}
			if (items.length === 0) return null;
			return {
				line: cursorLine,
				startCol: range.start,
				endCol: range.start + range.length,
				items,
			};
		} catch (error) {
			this.#disable(error);
			return null;
		}
	}

	#getTypoRanges(text: string): readonly native.SpellingRange[] {
		const cached = this.#typoCache.get(text);
		if (cached) return cached;
		let ranges: readonly native.SpellingRange[] = [];
		try {
			const masked = maskNonProse(text);
			ranges = this.backend
				.checkSpelling(text)
				.filter(range => isProseWord(text, masked, range.start, range.start + range.length))
				.toSorted((left, right) => left.start - right.start);
		} catch (error) {
			this.#disable(error);
		}
		if (this.#typoCache.size >= CACHE_LIMIT) this.#typoCache.clear();
		this.#typoCache.set(text, ranges);
		return ranges;
	}

	#context(lines: readonly string[], line: number): SpellingDecorationContext {
		return { editorText: lines.join("\n"), lines, line, startCol: 0 };
	}

	#sourceRangeIsProse(context: SpellingDecorationContext, startCol: number, endCol: number): boolean {
		if (context.editorText.length > MAX_SPELLING_BUFFER_LENGTH || startCol < 0 || endCol <= startCol) {
			return false;
		}
		const line = context.lines[context.line];
		if (line === undefined || line.length > MAX_SPELLING_LINE_LENGTH || endCol > line.length) return false;
		this.#prepareSource(context);
		const lineOffset = this.#sourceLineOffsets[context.line];
		if (lineOffset === undefined) return false;
		return this.#sourceMask.slice(lineOffset + startCol, lineOffset + endCol).trim().length > 0;
	}

	#prepareSource(context: SpellingDecorationContext): void {
		if (this.#sourceText === context.editorText) return;
		this.#sourceText = context.editorText;
		this.#sourceMask = maskNonProse(context.editorText);
		this.#sourceLineOffsets = new Array<number>(context.lines.length);
		let offset = 0;
		for (let line = 0; line < context.lines.length; line++) {
			this.#sourceLineOffsets[line] = offset;
			offset += (context.lines[line]?.length ?? 0) + 1;
		}
	}

	#disable(error: unknown): void {
		if (!this.#available) return;
		this.#available = false;
		this.#typoCache.clear();
		logger.warn("macOS spelling service failed; disabling editor spelling assistance", { error: String(error) });
	}
}
