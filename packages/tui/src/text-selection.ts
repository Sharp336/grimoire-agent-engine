/**
 * Visible-window text selection for the main-view TUI.
 *
 * Coordinates are 0-based screen cells (SGR mouse). Reconstruction and
 * highlight operate on already-composed viewport lines — the grok-build
 * visible-line algorithm, not the off-screen block engine.
 */

import { parseSgrMouse, type SgrMouseEvent } from "./mouse";
import { sliceByColumn, visibleWidth } from "./utils";

export interface Cell {
	row: number;
	col: number;
}

export interface TextSelection {
	anchor: Cell;
	head: Cell;
}

export function orderedRange(sel: TextSelection): { start: Cell; end: Cell } {
	const { anchor, head } = sel;
	if (anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col)) {
		return { start: anchor, end: head };
	}
	return { start: head, end: anchor };
}

export function selectionIsEmpty(sel: TextSelection): boolean {
	return sel.anchor.row === sel.head.row && sel.anchor.col === sel.head.col;
}

/** Reconstruct selected text from composed viewport lines. Strips ANSI. */
export function reconstructSelectionText(lines: readonly string[], sel: TextSelection): string {
	if (selectionIsEmpty(sel)) return "";
	const { start, end } = orderedRange(sel);
	const first = Math.max(0, start.row);
	const last = Math.min(lines.length - 1, end.row);
	if (last < first) return "";
	const out: string[] = [];
	for (let r = first; r <= last; r++) {
		const line = lines[r] ?? "";
		const width = visibleWidth(line);
		const from = r === start.row ? Math.min(width, Math.max(0, start.col)) : 0;
		const to = r === end.row ? Math.min(width, Math.max(0, end.col)) : width;
		const slice = to > from ? sliceByColumn(line, from, to - from, true) : "";
		out.push(Bun.stripANSI(slice).replace(/\s+$/u, ""));
	}
	return out.join("\n");
}

/** Invert the selected cells in place. Does not mutate line identity for empty ranges. */
export function applySelectionHighlight(lines: string[], sel: TextSelection): void {
	if (selectionIsEmpty(sel)) return;
	const { start, end } = orderedRange(sel);
	for (let r = Math.max(0, start.row); r <= end.row && r < lines.length; r++) {
		const line = lines[r] ?? "";
		const width = visibleWidth(line);
		const from = r === start.row ? Math.min(width, Math.max(0, start.col)) : 0;
		const to = r === end.row ? Math.min(width, Math.max(0, end.col)) : width;
		if (to <= from) continue;
		const before = from > 0 ? sliceByColumn(line, 0, from, true) : "";
		const mid = sliceByColumn(line, from, to - from, true);
		const after = to < width ? sliceByColumn(line, to, width - to, true) : "";
		lines[r] = `${before}\x1b[7m${mid}\x1b[27m${after}`;
	}
}

/**
 * Update selection from an SGR event. Returns:
 * - `"start"` / `"move"` when the drag changed
 * - `"copy"` when a non-empty selection was released
 * - `"scroll"` when the report is a wheel notch (not a selection gesture)
 * - `"ignore"` when the event is not a left-button selection gesture
 * - `"consumed"` when the event is a mouse report that must not reach the editor
 */
export function applySelectionMouse(
	sel: TextSelection | null,
	event: SgrMouseEvent,
): { selection: TextSelection | null; action: "start" | "move" | "copy" | "scroll" | "ignore" | "consumed" } {
	const cell: Cell = { row: event.row, col: event.col };
	if (event.wheel !== null) {
		return { selection: sel, action: "scroll" };
	}
	const button = event.button & 3;
	if (event.release) {
		if (!sel) return { selection: null, action: "consumed" };
		if (selectionIsEmpty(sel)) return { selection: null, action: "consumed" };
		return { selection: sel, action: "copy" };
	}
	if (event.leftClick) {
		return { selection: { anchor: cell, head: cell }, action: "start" };
	}
	if (event.motion && button === 0 && sel) {
		if (sel.head.row === cell.row && sel.head.col === cell.col) {
			return { selection: sel, action: "consumed" };
		}
		return { selection: { anchor: sel.anchor, head: cell }, action: "move" };
	}
	if (button !== 0) return { selection: sel, action: "ignore" };
	return { selection: sel, action: "consumed" };
}

/** Parse an SGR report and apply it to the current selection. */
export function applySelectionInput(
	sel: TextSelection | null,
	data: string,
): { selection: TextSelection | null; action: "start" | "move" | "copy" | "scroll" | "ignore" | "consumed" } | null {
	if (!data.startsWith("\x1b[<")) return null;
	const event = parseSgrMouse(data);
	if (!event) return null;
	return applySelectionMouse(sel, event);
}
