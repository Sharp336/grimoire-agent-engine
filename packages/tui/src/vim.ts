import { getSegmenter, moveWordLeft, moveWordRight } from "./utils";

/**
 * Modal editing state machine for {@link Editor}.
 *
 * Deliberately a *pure* state machine: it reads a snapshot of the buffer and returns the edits it
 * wants applied, so motions can be unit-tested without a terminal and the editor keeps sole
 * ownership of undo, atomic placeholder tokens, the kill ring, and `onChange`.
 *
 * This is a usable subset of Vim, not a reimplementation of it (see issue #3299): Normal and Visual
 * modes, the common motions, and operators built from those motions.
 */

export type VimMode = "insert" | "normal" | "visual" | "visual-line";

export type VimOperator = "d" | "y" | "c";

export interface VimPosition {
	line: number;
	col: number;
}

/** Read-only view of the editor buffer that motions resolve against. */
export interface VimBuffer {
	readonly lines: readonly string[];
	readonly cursorLine: number;
	readonly cursorCol: number;
}

/**
 * An edit the editor should apply. `to` is always an *exclusive* end offset, so ranges compose the
 * same way regardless of whether the originating motion was inclusive (`e`) or exclusive (`w`).
 */
export type VimCommand =
	| { kind: "move"; to: VimPosition }
	| { kind: "mode"; mode: VimMode }
	| { kind: "yank"; from: VimPosition; to: VimPosition; linewise: boolean }
	| { kind: "delete"; from: VimPosition; to: VimPosition; linewise: boolean; insert: boolean }
	| { kind: "openLine"; below: boolean }
	| { kind: "paste"; after: boolean; count: number }
	| { kind: "undo" };

const segmenter = getSegmenter();

const cursorOf = (buf: VimBuffer): VimPosition => ({ line: buf.cursorLine, col: buf.cursorCol });

/** Start offset of the grapheme after `col`, clamped to `text.length`. */
export function nextGraphemeStart(text: string, col: number): number {
	if (col >= text.length) return text.length;
	for (const seg of segmenter.segment(text)) {
		if (seg.index >= col) return Math.min(seg.index + seg.segment.length, text.length);
	}
	return text.length;
}

/** Start offset of the grapheme before `col`, clamped to 0. */
export function prevGraphemeStart(text: string, col: number): number {
	if (col <= 0) return 0;
	let last = 0;
	for (const seg of segmenter.segment(text)) {
		if (seg.index >= col) break;
		last = seg.index;
	}
	return last;
}

/** Offset of the final grapheme — where a Normal-mode cursor rests on a non-empty line. */
export function lastGraphemeStart(text: string): number {
	return prevGraphemeStart(text, text.length);
}

function firstNonBlank(text: string): number {
	for (const seg of segmenter.segment(text)) {
		if (seg.segment.trim() !== "") return seg.index;
	}
	return 0;
}

/** Vim's `w`: `moveWordRight` stops at the end of the current word, so skip the gap that follows. */
function wordForward(text: string, col: number): number {
	let next = moveWordRight(text, col);
	while (next < text.length && /\s/.test(text.charAt(next))) next++;
	return next;
}

/** Vim's `e`: the last grapheme of the word the cursor is about to run into. */
function wordEnd(text: string, col: number): number {
	let from = nextGraphemeStart(text, col);
	while (from < text.length && /\s/.test(text.charAt(from))) from++;
	const end = moveWordRight(text, from);
	return Math.max(col, prevGraphemeStart(text, end));
}

interface Motion {
	to: VimPosition;
	/** Inclusive motions cover the grapheme under `to` when used with an operator. */
	inclusive: boolean;
	linewise: boolean;
}

export class VimState {
	mode: VimMode = "normal";
	/** Fixed end of a Visual selection; the cursor is the moving end. */
	anchor: VimPosition | null = null;

	#count = "";
	#operator: VimOperator | null = null;
	#pendingG = false;
	/**
	 * Vim's "desired column": `j`/`k` remember the column you started from, so descending through a
	 * short line and back out returns to it instead of collapsing permanently. `null` means the
	 * next vertical motion anchors it to the live cursor column; `Infinity` is `$`'s sticky
	 * end-of-line, which keeps `$j` on the end of each line. Every non-vertical command clears it.
	 */
	#desiredCol: number | null = null;

	/** True while a count, operator, or `g` prefix is half-typed — Escape cancels that first. */
	get pending(): boolean {
		return this.#count.length > 0 || this.#operator !== null || this.#pendingG;
	}

	/**
	 * The half-typed command as Vim would echo it (`"2"`, `"d"`, `"2d"`, `"g"`) — empty when
	 * nothing is pending. Hosts render this next to the mode so a partially entered operator is
	 * visible instead of silently swallowing the next keystroke.
	 */
	get pendingText(): string {
		return `${this.#count}${this.#operator ?? ""}${this.#pendingG ? "g" : ""}`;
	}

	get visual(): boolean {
		return this.mode === "visual" || this.mode === "visual-line";
	}

	reset(): void {
		this.mode = "normal";
		this.anchor = null;
		this.#desiredCol = null;
		this.#clearPending();
	}

	#clearPending(): void {
		this.#count = "";
		this.#operator = null;
		this.#pendingG = false;
	}

	#takeCount(): number {
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;
		this.#count = "";
		return Math.max(1, count);
	}

	/** Clamp a position so the Normal-mode cursor rests *on* a grapheme rather than past the last. */
	#clampNormal(buf: VimBuffer, pos: VimPosition): VimPosition {
		const line = Math.max(0, Math.min(pos.line, buf.lines.length - 1));
		const text = buf.lines[line] ?? "";
		return { line, col: Math.max(0, Math.min(pos.col, lastGraphemeStart(text))) };
	}

	/**
	 * Handle one key. `key` is either the literal `"escape"` or a single grapheme; the editor
	 * normalizes arrow/Home/End keys onto their Vim equivalents before calling.
	 *
	 * Returns the commands to apply, or `null` when the key is not ours — the editor then falls
	 * through to its regular handling (and, for Escape in Normal mode, to the app's interrupt).
	 */
	handleKey(key: string, buf: VimBuffer): VimCommand[] | null {
		if (key === "escape") return this.#handleEscape(buf);
		if (this.mode === "insert") return null;

		// Count prefix. `0` is the line-start motion unless it extends a count already being typed.
		if ((key >= "1" && key <= "9") || (key === "0" && this.#count.length > 0)) {
			this.#count += key;
			return [];
		}

		if (this.#pendingG) {
			this.#pendingG = false;
			if (key !== "g") {
				this.#clearPending();
				return [];
			}
			// `gg` goes to the first line; `5gg` to line 5.
			this.#desiredCol = null;
			const line = Math.min(this.#takeCount() - 1, buf.lines.length - 1);
			return this.#applyMotion(buf, { to: { line, col: 0 }, inclusive: false, linewise: true });
		}

		// Only consecutive `j`/`k` carry the desired column; anything else re-anchors it. Counts and
		// the `g` prefix returned above, so `2j` still continues an established column.
		if (key !== "j" && key !== "k") this.#desiredCol = null;

		const motion = this.#resolveMotion(key, buf);
		if (motion) return this.#applyMotion(buf, motion);

		return this.visual ? this.#handleVisualKey(key, buf) : this.#handleNormalKey(key, buf);
	}

	#handleEscape(buf: VimBuffer): VimCommand[] | null {
		if (this.pending) {
			this.#clearPending();
			return [];
		}
		if (this.visual) {
			this.mode = "normal";
			this.anchor = null;
			return [
				{ kind: "mode", mode: "normal" },
				{ kind: "move", to: this.#clampNormal(buf, cursorOf(buf)) },
			];
		}
		if (this.mode === "insert") {
			this.mode = "normal";
			const text = buf.lines[buf.cursorLine] ?? "";
			return [
				{ kind: "mode", mode: "normal" },
				{ kind: "move", to: { line: buf.cursorLine, col: prevGraphemeStart(text, buf.cursorCol) } },
			];
		}
		// Normal mode with nothing pending: leave Escape to the app (interrupt / clear draft).
		return null;
	}

	#resolveMotion(key: string, buf: VimBuffer): Motion | null {
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;
		const line = buf.lines[buf.cursorLine] ?? "";
		const at = (col: number): VimPosition => ({ line: buf.cursorLine, col });

		switch (key === " " ? "l" : key) {
			case "h": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = prevGraphemeStart(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "l": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = nextGraphemeStart(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "j":
			case "k": {
				const delta = key === "j" ? count : -count;
				const target = Math.max(0, Math.min(buf.cursorLine + delta, buf.lines.length - 1));
				// Anchor the desired column on the first vertical move, then keep reusing it. The host
				// clamps the target to each line's length, so short lines en route never shrink it.
				this.#desiredCol ??= buf.cursorCol;
				return { to: { line: target, col: this.#desiredCol }, inclusive: false, linewise: true };
			}
			case "0":
				return { to: at(0), inclusive: false, linewise: false };
			case "^":
				return { to: at(firstNonBlank(line)), inclusive: false, linewise: false };
			case "$":
				// Sticky end-of-line, so `$j` lands on the end of each line rather than a fixed column.
				this.#desiredCol = Number.POSITIVE_INFINITY;
				return { to: at(line.length), inclusive: false, linewise: false };
			case "w": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = wordForward(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "b": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = moveWordLeft(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "e": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = wordEnd(line, col);
				return { to: at(col), inclusive: true, linewise: false };
			}
			case "G": {
				const target = this.#count.length > 0 ? count - 1 : buf.lines.length - 1;
				return {
					to: { line: Math.max(0, Math.min(target, buf.lines.length - 1)), col: 0 },
					inclusive: false,
					linewise: true,
				};
			}
			default:
				return null;
		}
	}

	/** Turn a resolved motion into either a cursor move, a selection extension, or an operator range. */
	#applyMotion(buf: VimBuffer, motion: Motion): VimCommand[] {
		const operator = this.#operator;
		this.#operator = null;
		this.#takeCount();

		if (operator === null) {
			// `$` parks on the last grapheme in Normal mode but must still be able to select the
			// final character in Visual mode, where the cursor is allowed one past it.
			const to = this.visual
				? { line: motion.to.line, col: Math.min(motion.to.col, (buf.lines[motion.to.line] ?? "").length) }
				: this.#clampNormal(buf, motion.to);
			return [{ kind: "move", to }];
		}

		const from: VimPosition = { line: buf.cursorLine, col: buf.cursorCol };
		let start = from;
		let end = motion.to;
		if (end.line < start.line || (end.line === start.line && end.col < start.col)) [start, end] = [end, start];
		if (motion.inclusive) {
			const text = buf.lines[end.line] ?? "";
			end = { line: end.line, col: nextGraphemeStart(text, end.col) };
		}
		return this.#operate(operator, start, end, motion.linewise);
	}

	#operate(operator: VimOperator, from: VimPosition, to: VimPosition, linewise: boolean): VimCommand[] {
		if (operator === "y") {
			return [
				{ kind: "yank", from, to, linewise },
				{ kind: "move", to: from },
			];
		}
		const insert = operator === "c";
		// `cc`/`cj` clear the lines but keep them, so a linewise change stays linewise-shaped.
		return [{ kind: "delete", from, to, linewise: linewise && !insert, insert }];
	}

	#handleNormalKey(key: string, buf: VimBuffer): VimCommand[] | null {
		const line = buf.lines[buf.cursorLine] ?? "";
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;

		switch (key) {
			case "g":
				this.#pendingG = true;
				return [];
			case "i":
				this.#takeCount();
				this.mode = "insert";
				return [{ kind: "mode", mode: "insert" }];
			case "a":
				this.#takeCount();
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: nextGraphemeStart(line, buf.cursorCol) } },
				];
			case "I":
				this.#takeCount();
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: firstNonBlank(line) } },
				];
			case "A":
				this.#takeCount();
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: line.length } },
				];
			case "o":
			case "O":
				this.#takeCount();
				this.mode = "insert";
				return [
					{ kind: "openLine", below: key === "o" },
					{ kind: "mode", mode: "insert" },
				];
			case "v":
			case "V":
				this.#takeCount();
				this.mode = key === "v" ? "visual" : "visual-line";
				this.anchor = { line: buf.cursorLine, col: buf.cursorCol };
				return [{ kind: "mode", mode: this.mode }];
			case "x": {
				this.#takeCount();
				let col = buf.cursorCol;
				for (let i = 0; i < count && col < line.length; i++) col = nextGraphemeStart(line, col);
				if (col === buf.cursorCol) return [];
				return [
					{
						kind: "delete",
						from: { line: buf.cursorLine, col: buf.cursorCol },
						to: { line: buf.cursorLine, col },
						linewise: false,
						insert: false,
					},
				];
			}
			case "D":
			case "C": {
				this.#takeCount();
				this.mode = key === "C" ? "insert" : this.mode;
				return [
					{
						kind: "delete",
						from: { line: buf.cursorLine, col: buf.cursorCol },
						to: { line: buf.cursorLine, col: line.length },
						linewise: false,
						insert: key === "C",
					},
				];
			}
			case "d":
			case "y":
			case "c":
				// A doubled operator (`dd`, `yy`, `cc`) is linewise over `count` lines.
				if (this.#operator === key) {
					const span = this.#takeCount();
					const last = Math.min(buf.cursorLine + span - 1, buf.lines.length - 1);
					this.#operator = null;
					return this.#operate(
						key,
						{ line: buf.cursorLine, col: 0 },
						{ line: last, col: (buf.lines[last] ?? "").length },
						true,
					);
				}
				this.#operator = key;
				return [];
			case "p":
			case "P":
				return [{ kind: "paste", after: key === "p", count: this.#takeCount() }];
			case "u":
				this.#takeCount();
				return [{ kind: "undo" }];
			default:
				// Normal mode swallows unknown printable keys rather than typing them into the buffer.
				this.#clearPending();
				return [];
		}
	}

	#handleVisualKey(key: string, buf: VimBuffer): VimCommand[] | null {
		const anchor = this.anchor ?? { line: buf.cursorLine, col: buf.cursorCol };
		const linewise = this.mode === "visual-line";

		switch (key) {
			case "v":
			case "V": {
				const next = key === "v" ? "visual" : "visual-line";
				if (this.mode === next) {
					this.mode = "normal";
					this.anchor = null;
					return [
						{ kind: "mode", mode: "normal" },
						{ kind: "move", to: this.#clampNormal(buf, cursorOf(buf)) },
					];
				}
				this.mode = next;
				return [{ kind: "mode", mode: next }];
			}
			case "o": {
				this.anchor = { line: buf.cursorLine, col: buf.cursorCol };
				return [{ kind: "move", to: anchor }];
			}
			case "y":
			case "d":
			case "x":
			case "c":
			case "s": {
				const operator: VimOperator = key === "y" ? "y" : key === "c" || key === "s" ? "c" : "d";
				const { from, to } = visualRange(buf, anchor, linewise);
				this.#clearPending();
				this.mode = operator === "c" ? "insert" : "normal";
				this.anchor = null;
				return [...this.#operate(operator, from, to, linewise), { kind: "mode", mode: this.mode }];
			}
			default:
				this.#clearPending();
				return [];
		}
	}
}

/**
 * Normalized, end-exclusive span covered by a Visual selection.
 *
 * Charwise selections include the grapheme under the cursor (Vim semantics); linewise selections
 * span whole lines, with `to.col` at the end of the last line so the caller can decide whether the
 * trailing newline goes too.
 */
export function visualRange(
	buf: VimBuffer,
	anchor: VimPosition,
	linewise: boolean,
): { from: VimPosition; to: VimPosition } {
	const cursor: VimPosition = { line: buf.cursorLine, col: buf.cursorCol };
	let from = anchor;
	let to = cursor;
	if (to.line < from.line || (to.line === from.line && to.col < from.col)) [from, to] = [to, from];

	if (linewise) {
		const lastLine = Math.min(to.line, buf.lines.length - 1);
		return { from: { line: from.line, col: 0 }, to: { line: lastLine, col: (buf.lines[lastLine] ?? "").length } };
	}
	const text = buf.lines[to.line] ?? "";
	return { from, to: { line: to.line, col: nextGraphemeStart(text, to.col) } };
}
