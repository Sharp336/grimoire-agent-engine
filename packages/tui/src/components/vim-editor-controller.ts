import type { KeybindingsManager } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { getSegmenter, getWordNavKind } from "../utils";

const segmenter = getSegmenter();
const MAX_VIM_COUNT = 1000;

type VimPendingCommand =
	| { kind: "operator"; operator: "d" | "c"; prefixCount: number; textObject?: "inner" | "around" }
	| { kind: "g"; count: number | undefined }
	| { kind: "visualTextObject"; textObject: "inner" | "around"; count: number };

export type VimEditorMode = "normal" | "insert" | "visual";

export type VimVisualSelection =
	| { kind: "line"; anchorLine: number; startLine: number; endLine: number }
	| { kind: "character"; anchor: number; start: number; end: number };

interface VimEditorCursor {
	line: number;
	col: number;
}

export interface VimEditorAdapter {
	getText(): string;
	getLines(): readonly string[];
	getCursor(): VimEditorCursor;
	setCursor(line: number, col: number): void;
	isShowingAutocomplete(): boolean;
	recordUndoState(): void;
	setUndoSuspended(suspended: boolean): void;
	applyUndo(): boolean;
	applyRedo(): boolean;
	deleteRange(start: number, end: number, enterInsert: boolean): void;
	deleteLineRange(startLine: number, endLine: number, enterInsert: boolean): void;
	openLines(line: number, count: number): void;
	onModeChange(mode: VimEditorMode): void;
}

export class VimEditorController {
	readonly #adapter: VimEditorAdapter;
	#pending: VimPendingCommand | undefined;
	#count = "";
	#insertUndoActive = false;
	#mode: VimEditorMode = "insert";
	#visualSelection: VimVisualSelection | undefined;

	constructor(adapter: VimEditorAdapter) {
		this.#adapter = adapter;
	}

	get mode(): VimEditorMode {
		return this.#mode;
	}

	get visualSelection(): VimVisualSelection | undefined {
		return this.#visualSelection;
	}

	get insertUndoActive(): boolean {
		return this.#insertUndoActive;
	}

	setEnabled(enabled: boolean): void {
		this.finishInsertUndo();
		this.#pending = undefined;
		this.#count = "";
		this.#visualSelection = undefined;
		this.#mode = enabled ? "normal" : "insert";
		if (enabled) this.clampNormalCursor();
	}

	isModeEscape(data: string): boolean {
		return this.#mode !== "normal" && this.#isEscape(data);
	}

	finishInsertUndo(): void {
		if (!this.#insertUndoActive) return;
		this.#insertUndoActive = false;
		this.#adapter.setUndoSuspended(false);
	}

	enterNormalMode(): void {
		this.finishInsertUndo();
		this.#pending = undefined;
		this.#visualSelection = undefined;
		this.#count = "";
		const changed = this.#mode !== "normal";
		this.#mode = "normal";
		this.clampNormalCursor();
		if (changed) this.#adapter.onModeChange("normal");
	}

	prepareInsertInput(data: string, kb: KeybindingsManager): void {
		if (!this.#adapter.isShowingAutocomplete() && data !== "\n" && kb.matches(data, "tui.input.submit")) {
			this.enterNormalMode();
			return;
		}
		if (this.#insertUndoActive) return;

		const mutates =
			extractPrintableText(data) !== undefined ||
			kb.matches(data, "tui.input.newLine") ||
			kb.matches(data, "tui.editor.deleteCharBackward") ||
			kb.matches(data, "tui.editor.deleteCharForward") ||
			matchesKey(data, "shift+backspace") ||
			matchesKey(data, "shift+delete") ||
			matchesKey(data, "ctrl+k") ||
			matchesKey(data, "ctrl+u") ||
			matchesKey(data, "ctrl+w") ||
			matchesKey(data, "alt+backspace") ||
			matchesKey(data, "super+alt+backspace") ||
			matchesKey(data, "alt+d") ||
			matchesKey(data, "alt+delete") ||
			matchesKey(data, "super+alt+d") ||
			matchesKey(data, "super+alt+delete") ||
			matchesKey(data, "ctrl+y") ||
			data === "\n" ||
			(data.length > 1 && data.includes("\r"));
		if (!mutates) return;

		this.#beginInsertUndo();
	}

	preparePaste(): void {
		if (!this.#insertUndoActive) this.#beginInsertUndo();
	}

	prepareCompletion(): void {
		if (this.#mode === "insert" && !this.#insertUndoActive) this.#beginInsertUndo();
	}

	clearPendingCommand(): void {
		this.#pending = undefined;
		this.#count = "";
	}

	handleNormalInput(data: string, kb: KeybindingsManager): boolean {
		if (this.#isEscape(data)) {
			if (this.#mode === "visual") this.enterNormalMode();
			else {
				this.#pending = undefined;
				this.#count = "";
			}
			return true;
		}
		if (this.#mode === "visual" && this.#handleVisualNavigation(data, kb)) return true;
		if (data === "\n") {
			this.clearPendingCommand();
			return true;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.clearPendingCommand();
			return this.#mode === "visual";
		}
		if (matchesKey(data, "ctrl+r")) {
			if (this.#mode === "visual") {
				this.#count = "";
				return true;
			}
			const count = this.#takeCount();
			for (let i = 0; i < count; i++) {
				if (!this.#adapter.applyRedo()) break;
			}
			this.clampNormalCursor();
			return true;
		}
		if (
			kb.matches(data, "tui.input.tab") ||
			kb.matches(data, "tui.input.newLine") ||
			matchesKey(data, "alt+enter") ||
			matchesKey(data, "ctrl+enter") ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && (data.charCodeAt(0) === 10 || data.includes("\r"))) ||
			kb.matches(data, "tui.editor.deleteCharBackward") ||
			kb.matches(data, "tui.editor.deleteCharForward") ||
			matchesKey(data, "shift+backspace") ||
			matchesKey(data, "shift+delete") ||
			matchesKey(data, "ctrl+k") ||
			matchesKey(data, "ctrl+u") ||
			matchesKey(data, "ctrl+w") ||
			matchesKey(data, "alt+backspace") ||
			matchesKey(data, "super+alt+backspace") ||
			matchesKey(data, "alt+d") ||
			matchesKey(data, "alt+delete") ||
			matchesKey(data, "super+alt+d") ||
			matchesKey(data, "super+alt+delete") ||
			matchesKey(data, "ctrl+y") ||
			matchesKey(data, "alt+y")
		) {
			this.clearPendingCommand();
			return true;
		}
		const printable = extractPrintableText(data);
		const graphemes = printable ? [...segmenter.segment(printable)] : [];
		if (graphemes.length !== 1) {
			if (printable === undefined) {
				this.#pending = undefined;
				this.#count = "";
			}
			return printable !== undefined;
		}
		const char = graphemes[0]?.segment;
		if (!char) return false;
		if (this.#mode === "visual") return this.#handleVisualInput(char);

		if (this.#pending?.kind === "operator") return this.#handleOperatorInput(char);
		if (this.#pending?.kind === "g") {
			const pending = this.#pending;
			this.#pending = undefined;
			this.#count = "";
			if (char === "g") this.#setCursor(pending.count === undefined ? 0 : pending.count - 1, 0);
			return true;
		}

		if (/[1-9]/u.test(char) || (char === "0" && this.#count.length > 0)) {
			this.#appendCountDigit(char);
			return true;
		}

		switch (char) {
			case "h":
				this.#moveHorizontal(-1, this.#takeCount());
				return true;
			case "j":
				this.#moveVertical(1, this.#takeCount());
				return true;
			case "k":
				this.#moveVertical(-1, this.#takeCount());
				return true;
			case "l":
				this.#moveHorizontal(1, this.#takeCount());
				return true;
			case "w":
				this.#setAbsoluteCursor(this.#wordForwardPosition(this.#absoluteCursor(), this.#takeCount(), false));
				return true;
			case "W":
				this.#setAbsoluteCursor(this.#wordForwardPosition(this.#absoluteCursor(), this.#takeCount(), true));
				return true;
			case "b":
				this.#setAbsoluteCursor(this.#wordBackwardPosition(this.#absoluteCursor(), this.#takeCount(), false));
				return true;
			case "B":
				this.#setAbsoluteCursor(this.#wordBackwardPosition(this.#absoluteCursor(), this.#takeCount(), true));
				return true;
			case "e":
				this.#setAbsoluteCursor(this.#wordEndPosition(this.#absoluteCursor(), this.#takeCount(), false));
				return true;
			case "E":
				this.#setAbsoluteCursor(this.#wordEndPosition(this.#absoluteCursor(), this.#takeCount(), true));
				return true;
			case "0":
				this.#count = "";
				this.#setCursor(this.#cursor().line, 0);
				return true;
			case "^":
				this.#count = "";
				this.#setCursor(this.#cursor().line, this.#firstNonBlankCol(this.#currentLine()));
				return true;
			case "$": {
				const lines = this.#lines();
				const targetLine = Math.min(lines.length - 1, this.#cursor().line + this.#takeCount() - 1);
				this.#setCursor(targetLine, this.#lineLastCol(lines[targetLine] ?? ""));
				return true;
			}
			case "G": {
				const lines = this.#lines();
				const count = this.#takeOptionalCount();
				const targetLine = count === undefined ? lines.length - 1 : count - 1;
				this.#setCursor(targetLine, this.#firstNonBlankCol(lines[targetLine] ?? ""));
				return true;
			}
			case "g":
				this.#pending = { kind: "g", count: this.#takeOptionalCount() };
				return true;
			case "v":
				this.#enterVisualCharacterMode();
				return true;
			case "V":
				this.#enterVisualLineMode();
				return true;
			case "i":
				this.#count = "";
				this.#enterInsertMode();
				return true;
			case "a":
				this.#count = "";
				this.#enterInsertMode(false, this.#graphemeEndAt(this.#currentLine(), this.#cursor().col));
				return true;
			case "I":
				this.#count = "";
				this.#enterInsertMode(false, this.#firstNonBlankCol(this.#currentLine()));
				return true;
			case "A":
				this.#count = "";
				this.#enterInsertMode(false, this.#currentLine().length);
				return true;
			case "o":
				this.#openLines(1, this.#takeCount());
				return true;
			case "O":
				this.#openLines(0, this.#takeCount());
				return true;
			case "x":
				this.#deleteCharacters(this.#takeCount());
				return true;
			case "D":
				this.#deleteToLineEnd(this.#takeCount(), false);
				return true;
			case "C":
				this.#deleteToLineEnd(this.#takeCount(), true);
				return true;
			case "d":
			case "c":
				this.#pending = { kind: "operator", operator: char, prefixCount: this.#takeCount() };
				return true;
			case "u": {
				const count = this.#takeCount();
				for (let i = 0; i < count; i++) {
					if (!this.#adapter.applyUndo()) break;
				}
				this.clampNormalCursor();
				return true;
			}
			default:
				this.#count = "";
				return true;
		}
	}

	#handleVisualNavigation(data: string, kb: KeybindingsManager): boolean {
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.#moveHorizontal(-1, this.#takeCount());
		} else if (kb.matches(data, "tui.editor.cursorRight")) {
			this.#moveHorizontal(1, this.#takeCount());
		} else if (kb.matches(data, "tui.editor.cursorUp")) {
			this.#moveVertical(-1, this.#takeCount());
		} else if (kb.matches(data, "tui.editor.cursorDown")) {
			this.#moveVertical(1, this.#takeCount());
		} else if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.#setAbsoluteCursor(this.#wordBackwardPosition(this.#absoluteCursor(), this.#takeCount(), false));
		} else if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.#setAbsoluteCursor(this.#wordForwardPosition(this.#absoluteCursor(), this.#takeCount(), false));
		} else if (kb.matches(data, "tui.editor.cursorLineStart") || matchesKey(data, "ctrl+a")) {
			this.#count = "";
			this.#setCursor(this.#cursor().line, 0);
		} else if (kb.matches(data, "tui.editor.cursorLineEnd") || matchesKey(data, "ctrl+e")) {
			this.#count = "";
			this.#setCursor(this.#cursor().line, this.#lineLastCol(this.#currentLine()));
		} else if (
			kb.matches(data, "tui.editor.pageUp") ||
			kb.matches(data, "tui.editor.pageDown") ||
			kb.matches(data, "tui.editor.jumpForward") ||
			kb.matches(data, "tui.editor.jumpBackward")
		) {
			this.#count = "";
			this.clearPendingCommand();
			return true;
		} else {
			return false;
		}
		return this.#finishVisualMotion();
	}

	clampNormalCursor(): void {
		if (this.#mode !== "normal") return;
		const cursor = this.#cursor();
		this.#setCursor(cursor.line, cursor.col);
	}

	#beginInsertUndo(): void {
		this.#adapter.recordUndoState();
		this.#insertUndoActive = true;
		this.#adapter.setUndoSuspended(true);
	}

	#isEscape(data: string): boolean {
		return matchesKey(data, "escape") || matchesKey(data, "esc");
	}

	#enterInsertMode(existingUndo = false, col?: number): void {
		if (col !== undefined) this.#adapter.setCursor(this.#cursor().line, col);
		this.#pending = undefined;
		this.#count = "";
		this.#visualSelection = undefined;
		if (existingUndo) {
			this.#insertUndoActive = true;
			this.#adapter.setUndoSuspended(true);
		}
		const changed = this.#mode !== "insert";
		this.#mode = "insert";
		if (changed) this.#adapter.onModeChange("insert");
	}

	#enterVisualCharacterMode(): void {
		this.finishInsertUndo();
		this.#pending = undefined;
		this.#count = "";
		const anchor = this.#absoluteCursor();
		this.#visualSelection = {
			kind: "character",
			anchor,
			start: anchor,
			end: this.#graphemeEndAt(this.#adapter.getText(), anchor),
		};
		const changed = this.#mode !== "visual";
		this.#mode = "visual";
		if (changed) this.#adapter.onModeChange("visual");
	}

	#enterVisualLineMode(): void {
		this.finishInsertUndo();
		this.#pending = undefined;
		this.#count = "";
		const line = this.#cursor().line;
		this.#visualSelection = { kind: "line", anchorLine: line, startLine: line, endLine: line + 1 };
		const changed = this.#mode !== "visual";
		this.#mode = "visual";
		if (changed) this.#adapter.onModeChange("visual");
	}

	#updateVisualSelection(): void {
		const selection = this.#visualSelection;
		if (selection?.kind === "line") {
			const line = this.#cursor().line;
			this.#visualSelection = {
				...selection,
				startLine: Math.min(selection.anchorLine, line),
				endLine: Math.max(selection.anchorLine, line) + 1,
			};
		} else if (selection?.kind === "character") {
			const text = this.#adapter.getText();
			const cursor = this.#absoluteCursor();
			this.#visualSelection = {
				...selection,
				start: Math.min(selection.anchor, cursor),
				end: Math.max(this.#graphemeEndAt(text, selection.anchor), this.#graphemeEndAt(text, cursor)),
			};
		}
	}

	#finishVisualMotion(): boolean {
		this.clearPendingCommand();
		this.#updateVisualSelection();
		return true;
	}

	#handleVisualInput(char: string): boolean {
		const pending = this.#pending;
		if (pending?.kind === "g") {
			this.#pending = undefined;
			this.#count = "";
			if (char === "g") {
				this.#setCursor(pending.count === undefined ? 0 : pending.count - 1, 0);
				this.#updateVisualSelection();
			}
			return true;
		}

		if (pending?.kind === "visualTextObject") {
			this.#pending = undefined;
			if (char === "p") {
				const range = this.#paragraphLineRange(pending.count, pending.textObject === "around");
				this.#visualSelection = { kind: "line", anchorLine: range.startLine, ...range };
				this.#setCursor(range.endLine - 1, 0);
			} else if (char === "w" || char === "W") {
				const range = this.#wordTextObjectRange(
					this.#absoluteCursor(),
					pending.count,
					char === "W",
					pending.textObject === "around",
				);
				this.#visualSelection = { kind: "character", anchor: range.start, ...range };
				this.#setAbsoluteCursor(this.#previousGraphemeStart(this.#adapter.getText(), range.end));
			}
			return true;
		}

		if (/[1-9]/u.test(char) || (char === "0" && this.#count.length > 0)) {
			this.#appendCountDigit(char);
			return true;
		}

		switch (char) {
			case "i":
			case "a":
				this.#pending = {
					kind: "visualTextObject",
					textObject: char === "i" ? "inner" : "around",
					count: this.#takeCount(),
				};
				return true;
			case "h":
				this.#moveHorizontal(-1, this.#takeCount());
				return this.#finishVisualMotion();
			case "j":
				this.#moveVertical(1, this.#takeCount());
				return this.#finishVisualMotion();
			case "k":
				this.#moveVertical(-1, this.#takeCount());
				return this.#finishVisualMotion();
			case "l":
				this.#moveHorizontal(1, this.#takeCount());
				return this.#finishVisualMotion();
			case "w":
				this.#setAbsoluteCursor(this.#wordForwardPosition(this.#absoluteCursor(), this.#takeCount(), false));
				return this.#finishVisualMotion();
			case "W":
				this.#setAbsoluteCursor(this.#wordForwardPosition(this.#absoluteCursor(), this.#takeCount(), true));
				return this.#finishVisualMotion();
			case "b":
				this.#setAbsoluteCursor(this.#wordBackwardPosition(this.#absoluteCursor(), this.#takeCount(), false));
				return this.#finishVisualMotion();
			case "B":
				this.#setAbsoluteCursor(this.#wordBackwardPosition(this.#absoluteCursor(), this.#takeCount(), true));
				return this.#finishVisualMotion();
			case "e":
				this.#setAbsoluteCursor(this.#wordEndPosition(this.#absoluteCursor(), this.#takeCount(), false));
				return this.#finishVisualMotion();
			case "E":
				this.#setAbsoluteCursor(this.#wordEndPosition(this.#absoluteCursor(), this.#takeCount(), true));
				return this.#finishVisualMotion();
			case "0":
				this.#count = "";
				this.#setCursor(this.#cursor().line, 0);
				return this.#finishVisualMotion();
			case "^":
				this.#count = "";
				this.#setCursor(this.#cursor().line, this.#firstNonBlankCol(this.#currentLine()));
				return this.#finishVisualMotion();
			case "$": {
				const lines = this.#lines();
				const targetLine = Math.min(lines.length - 1, this.#cursor().line + this.#takeCount() - 1);
				this.#setCursor(targetLine, this.#lineLastCol(lines[targetLine] ?? ""));
				return this.#finishVisualMotion();
			}
			case "G": {
				const lines = this.#lines();
				const count = this.#takeOptionalCount();
				const targetLine = count === undefined ? lines.length - 1 : count - 1;
				this.#setCursor(targetLine, this.#firstNonBlankCol(lines[targetLine] ?? ""));
				return this.#finishVisualMotion();
			}
			case "g":
				this.#pending = { kind: "g", count: this.#takeOptionalCount() };
				return true;
			case "v":
				if (this.#visualSelection?.kind === "character") this.enterNormalMode();
				else this.#enterVisualCharacterMode();
				return true;
			case "V":
				if (this.#visualSelection?.kind === "line") this.enterNormalMode();
				else this.#enterVisualLineMode();
				return true;
			case "d":
			case "c": {
				const selection = this.#visualSelection;
				if (!selection) return true;
				const enterInsert = char === "c";
				if (selection.kind === "line") {
					this.enterNormalMode();
					this.#deleteLineRange(selection.startLine, selection.endLine, enterInsert);
				} else {
					this.enterNormalMode();
					this.#deleteRange(selection.start, selection.end, enterInsert);
				}
				return true;
			}
			default:
				this.#pending = undefined;
				this.#count = "";
				return true;
		}
	}

	#handleOperatorInput(char: string): boolean {
		const pending = this.#pending;
		if (pending?.kind !== "operator") return false;

		if (/[1-9]/u.test(char) || (char === "0" && this.#count.length > 0)) {
			this.#appendCountDigit(char);
			return true;
		}

		if ((char === "i" || char === "a") && pending.textObject === undefined) {
			this.#pending = { ...pending, textObject: char === "i" ? "inner" : "around" };
			return true;
		}

		this.#pending = undefined;
		const count = Math.min(MAX_VIM_COUNT, pending.prefixCount * this.#takeCount());
		const enterInsert = pending.operator === "c";
		if (pending.textObject !== undefined) {
			if (char === "w" || char === "W") {
				const range = this.#wordTextObjectRange(
					this.#absoluteCursor(),
					count,
					char === "W",
					pending.textObject === "around",
				);
				this.#deleteRange(range.start, range.end, enterInsert);
			} else if (char === "p") {
				this.#deleteParagraphs(count, enterInsert, pending.textObject === "around");
			}
			return true;
		}

		if (char === pending.operator) {
			const startLine = this.#cursor().line;
			this.#deleteLineRange(startLine, startLine + count, enterInsert);
			return true;
		}

		const start = this.#absoluteCursor();
		let endpoint: number | undefined;
		switch (char) {
			case "w":
			case "W": {
				const bigWord = char === "W";
				endpoint =
					enterInsert && this.#classAt(start, bigWord) !== "whitespace"
						? this.#graphemeEndAt(this.#adapter.getText(), this.#wordEndPosition(start, count, bigWord))
						: this.#wordForwardPosition(start, count, bigWord);
				break;
			}
			case "b":
				endpoint = this.#wordBackwardPosition(start, count, false);
				break;
			case "B":
				endpoint = this.#wordBackwardPosition(start, count, true);
				break;
			case "e":
				endpoint = this.#graphemeEndAt(this.#adapter.getText(), this.#wordEndPosition(start, count, false));
				break;
			case "E":
				endpoint = this.#graphemeEndAt(this.#adapter.getText(), this.#wordEndPosition(start, count, true));
				break;
			case "h":
				endpoint = this.#absoluteLineStart(this.#cursor().line) + this.#moveCol(-1, count);
				break;
			case "l":
				endpoint =
					this.#absoluteLineStart(this.#cursor().line) +
					this.#graphemeEndAt(this.#currentLine(), this.#moveCol(1, count));
				break;
			case "0":
				endpoint = this.#absoluteLineStart(this.#cursor().line);
				break;
			case "$":
				endpoint = this.#lineEndAbsolute(Math.min(this.#lines().length - 1, this.#cursor().line + count - 1));
				break;
			default:
				return true;
		}

		this.#deleteRange(start, endpoint, enterInsert);
		return true;
	}

	#appendCountDigit(digit: string): void {
		const current = this.#count.length === 0 ? 0 : Number(this.#count);
		this.#count = String(Math.min(MAX_VIM_COUNT, current * 10 + Number(digit)));
	}

	#takeCount(): number {
		const count = this.#count.length === 0 ? 1 : Number(this.#count);
		this.#count = "";
		return Number.isSafeInteger(count) && count > 0 ? Math.min(count, MAX_VIM_COUNT) : 1;
	}

	#takeOptionalCount(): number | undefined {
		if (this.#count.length === 0) return undefined;
		return this.#takeCount();
	}

	#lines(): readonly string[] {
		return this.#adapter.getLines();
	}

	#cursor(): VimEditorCursor {
		return this.#adapter.getCursor();
	}

	#currentLine(): string {
		const cursor = this.#cursor();
		return this.#lines()[cursor.line] ?? "";
	}

	#firstNonBlankCol(line: string): number {
		const index = line.search(/\S/u);
		return index < 0 ? 0 : this.#graphemeStartAtOrBefore(line, index);
	}

	#lineLastCol(line: string): number {
		let last = 0;
		for (const grapheme of segmenter.segment(line)) last = grapheme.index;
		return last;
	}

	#graphemeStartAtOrBefore(text: string, col: number): number {
		const bounded = Math.max(0, Math.min(text.length, Math.trunc(col)));
		let last = 0;
		for (const grapheme of segmenter.segment(text)) {
			const end = grapheme.index + grapheme.segment.length;
			if (bounded < end) return grapheme.index;
			last = grapheme.index;
		}
		return last;
	}

	#graphemeEndAt(text: string, col: number): number {
		const bounded = Math.max(0, Math.min(text.length, Math.trunc(col)));
		for (const grapheme of segmenter.segment(text)) {
			const end = grapheme.index + grapheme.segment.length;
			if (bounded <= grapheme.index || bounded < end) return end;
		}
		return text.length;
	}

	#previousGraphemeStart(text: string, col: number): number {
		const bounded = Math.max(0, Math.min(text.length, Math.trunc(col)));
		let previous = 0;
		for (const grapheme of segmenter.segment(text)) {
			if (grapheme.index >= bounded) return previous;
			previous = grapheme.index;
		}
		return previous;
	}

	#setCursor(line: number, col: number): void {
		const lines = this.#lines();
		const targetLine = Math.max(0, Math.min(lines.length - 1, Math.trunc(line)));
		const text = lines[targetLine] ?? "";
		this.#adapter.setCursor(targetLine, this.#graphemeStartAtOrBefore(text, col));
	}

	#moveCol(direction: -1 | 1, count: number): number {
		const line = this.#currentLine();
		const col = this.#cursor().col;
		if (direction > 0) {
			let remaining = count;
			let target = col;
			for (const grapheme of segmenter.segment(line)) {
				if (grapheme.index <= col) continue;
				target = grapheme.index;
				if (--remaining === 0) break;
			}
			return target;
		}

		const priorStarts = new Array<number>(count);
		let seen = 0;
		for (const grapheme of segmenter.segment(line)) {
			if (grapheme.index >= col) break;
			priorStarts[seen % count] = grapheme.index;
			seen++;
		}
		if (seen === 0) return col;
		return priorStarts[seen <= count ? 0 : (seen - count) % count] ?? 0;
	}

	#moveHorizontal(direction: -1 | 1, count: number): void {
		this.#setCursor(this.#cursor().line, this.#moveCol(direction, count));
	}

	#moveVertical(direction: -1 | 1, count: number): void {
		const cursor = this.#cursor();
		const targetLine = Math.max(0, Math.min(this.#lines().length - 1, cursor.line + direction * count));
		this.#setCursor(targetLine, cursor.col);
	}

	#absoluteLineStart(line: number): number {
		let offset = 0;
		for (let i = 0; i < line; i++) offset += (this.#lines()[i] ?? "").length + 1;
		return offset;
	}

	#lineEndAbsolute(line: number): number {
		return this.#absoluteLineStart(line) + (this.#lines()[line] ?? "").length;
	}

	#absoluteCursor(): number {
		const cursor = this.#cursor();
		return this.#absoluteLineStart(cursor.line) + cursor.col;
	}

	#setAbsoluteCursor(pos: number, allowLineEnd = false): void {
		let remaining = Math.max(0, Math.min(this.#adapter.getText().length, Math.trunc(pos)));
		const lines = this.#lines();
		for (let line = 0; line < lines.length; line++) {
			const text = lines[line] ?? "";
			if (remaining <= text.length || line === lines.length - 1) {
				const col =
					allowLineEnd && remaining >= text.length ? text.length : this.#graphemeStartAtOrBefore(text, remaining);
				this.#adapter.setCursor(line, col);
				return;
			}
			remaining -= text.length + 1;
		}
	}

	#segments(text: string, bigWord: boolean): Array<{ index: number; segment: string; kind: string }> {
		return [...segmenter.segment(text)].map(grapheme => ({
			index: grapheme.index,
			segment: grapheme.segment,
			kind: this.#wordKind(grapheme.segment, bigWord),
		}));
	}

	#wordKind(grapheme: string, bigWord: boolean): string {
		const kind = getWordNavKind(grapheme);
		if (kind === "whitespace") return "whitespace";
		if (bigWord) return "word";
		return kind === "word" || kind === "cjk" ? "word" : "delimiter";
	}

	#classAt(pos: number, bigWord: boolean): string {
		const text = this.#adapter.getText();
		for (const grapheme of segmenter.segment(text)) {
			if (pos < grapheme.index + grapheme.segment.length) return this.#wordKind(grapheme.segment, bigWord);
		}
		return "whitespace";
	}

	#segmentIndexAt(segments: Array<{ index: number; segment: string; kind: string }>, pos: number): number {
		for (let i = 0; i < segments.length; i++) {
			const grapheme = segments[i];
			if (grapheme && pos < grapheme.index + grapheme.segment.length) return i;
		}
		return segments.length;
	}

	#wordTextObjectRange(
		start: number,
		count: number,
		bigWord: boolean,
		around: boolean,
	): { start: number; end: number } {
		const text = this.#adapter.getText();
		const segments = this.#segments(text, bigWord);
		let first = this.#segmentIndexAt(segments, start);
		if (first >= segments.length) return { start, end: start };

		const firstKind = segments[first]?.kind;
		while (first > 0 && segments[first - 1]?.kind === firstKind) first--;

		let end = first;
		const consumeGroup = (): void => {
			const kind = segments[end]?.kind;
			while (end < segments.length && segments[end]?.kind === kind) end++;
		};
		consumeGroup();
		for (let step = 1; step < count && end < segments.length; step++) {
			while (end < segments.length && segments[end]?.kind === "whitespace") end++;
			if (end < segments.length) consumeGroup();
		}

		if (around) {
			const innerEnd = end;
			while (end < segments.length && segments[end]?.kind === "whitespace") end++;
			if (end === innerEnd) {
				while (first > 0 && segments[first - 1]?.kind === "whitespace") first--;
			}
		}

		return { start: segments[first]?.index ?? start, end: segments[end]?.index ?? text.length };
	}

	#wordForwardPosition(start: number, count: number, bigWord: boolean): number {
		const text = this.#adapter.getText();
		const segments = this.#segments(text, bigWord);
		let pos = start;
		let index = this.#segmentIndexAt(segments, pos);
		for (let step = 0; step < count; step++) {
			if (index >= segments.length) return text.length;
			const kind = segments[index]?.kind;
			if (kind !== "whitespace") {
				while (index < segments.length && segments[index]?.kind === kind) index++;
			}
			while (index < segments.length && segments[index]?.kind === "whitespace") index++;
			pos = segments[index]?.index ?? text.length;
		}
		return pos;
	}

	#wordBackwardPosition(start: number, count: number, bigWord: boolean): number {
		const segments = this.#segments(this.#adapter.getText(), bigWord);
		let pos = start;
		let index = this.#segmentIndexAt(segments, pos);
		for (let step = 0; step < count; step++) {
			if (index >= segments.length || segments[index]?.index === pos) index--;
			while (index >= 0 && segments[index]?.kind === "whitespace") index--;
			if (index < 0) return 0;
			const kind = segments[index]?.kind;
			while (index > 0 && segments[index - 1]?.kind === kind) index--;
			pos = segments[index]?.index ?? 0;
		}
		return pos;
	}

	#wordEndPosition(start: number, count: number, bigWord: boolean): number {
		const text = this.#adapter.getText();
		const segments = this.#segments(text, bigWord);
		let pos = start;
		let index = this.#segmentIndexAt(segments, pos);
		for (let step = 0; step < count; step++) {
			if (index >= segments.length) return this.#previousGraphemeStart(text, text.length);
			const kind = segments[index]?.kind;
			if (kind !== "whitespace" && index + 1 < segments.length && segments[index + 1]?.kind === kind) {
				while (index + 1 < segments.length && segments[index + 1]?.kind === kind) index++;
			} else {
				index++;
				while (index < segments.length && segments[index]?.kind === "whitespace") index++;
				const nextKind = segments[index]?.kind;
				while (index + 1 < segments.length && segments[index + 1]?.kind === nextKind) index++;
			}
			const next = segments[index]?.index ?? this.#previousGraphemeStart(text, text.length);
			if (next === pos) return pos;
			pos = next;
		}
		return pos;
	}

	#paragraphLineRange(count: number, around: boolean): { startLine: number; endLine: number } {
		const lines = this.#lines();
		const isBlank = (line: string): boolean => line.trim().length === 0;
		let paragraphLine = this.#cursor().line;
		if (isBlank(lines[paragraphLine] ?? "")) {
			while (paragraphLine < lines.length && isBlank(lines[paragraphLine] ?? "")) paragraphLine++;
			if (paragraphLine >= lines.length) {
				paragraphLine = this.#cursor().line;
				while (paragraphLine > 0 && isBlank(lines[paragraphLine] ?? "")) paragraphLine--;
			}
		}

		let startLine = paragraphLine;
		while (startLine > 0 && !isBlank(lines[startLine - 1] ?? "")) startLine--;
		let endLine = paragraphLine + 1;
		while (endLine < lines.length && !isBlank(lines[endLine] ?? "")) endLine++;

		for (let step = 1; step < count; step++) {
			if (endLine >= lines.length) break;
			while (endLine < lines.length && isBlank(lines[endLine] ?? "")) endLine++;
			while (endLine < lines.length && !isBlank(lines[endLine] ?? "")) endLine++;
		}

		if (around) {
			const paragraphEnd = endLine;
			while (endLine < lines.length && isBlank(lines[endLine] ?? "")) endLine++;
			if (endLine === paragraphEnd) {
				while (startLine > 0 && isBlank(lines[startLine - 1] ?? "")) startLine--;
			}
		}
		return { startLine, endLine };
	}

	#deleteCharacters(count: number): void {
		const start = this.#absoluteCursor();
		const startCol = this.#cursor().col;
		let endCol = startCol;
		let remaining = count;
		for (const grapheme of segmenter.segment(this.#currentLine())) {
			if (grapheme.index < startCol) continue;
			endCol = grapheme.index + grapheme.segment.length;
			if (--remaining === 0) break;
		}
		this.#deleteRange(start, this.#absoluteLineStart(this.#cursor().line) + endCol, false);
	}

	#deleteToLineEnd(count: number, enterInsert: boolean): void {
		const targetLine = Math.min(this.#lines().length - 1, this.#cursor().line + count - 1);
		this.#deleteRange(this.#absoluteCursor(), this.#lineEndAbsolute(targetLine), enterInsert);
	}

	#deleteParagraphs(count: number, enterInsert: boolean, around: boolean): void {
		const range = this.#paragraphLineRange(count, around);
		this.#deleteLineRange(range.startLine, range.endLine, enterInsert);
	}

	#deleteRange(start: number, end: number, enterInsert: boolean): void {
		this.#adapter.deleteRange(start, end, enterInsert);
		if (enterInsert) this.#enterInsertMode(true, this.#cursor().col);
		else this.clampNormalCursor();
	}

	#deleteLineRange(startLine: number, endLine: number, enterInsert: boolean): void {
		this.#adapter.deleteLineRange(startLine, endLine, enterInsert);
		if (enterInsert) this.#enterInsertMode(true, 0);
		else this.clampNormalCursor();
	}

	#openLines(offset: 0 | 1, count: number): void {
		this.#adapter.openLines(this.#cursor().line + offset, Math.min(count, MAX_VIM_COUNT));
		this.#enterInsertMode(true, 0);
	}
}
