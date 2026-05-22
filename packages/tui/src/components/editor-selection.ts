/**
 * Pure helpers for editor text selection geometry.
 *
 * These operate on logical lines/columns and have no dependency on rendering,
 * so they can be unit-tested in isolation and reused by a future mouse-selection
 * path. Columns are character (code-unit) offsets within a line, matching the
 * editor's `cursorCol`.
 */

export interface Pos {
	line: number;
	col: number;
}

export interface SelectionRange {
	start: Pos;
	end: Pos;
}

/** True when `a` comes strictly before `b` in document order. */
function isBefore(a: Pos, b: Pos): boolean {
	return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/** Order two endpoints into a document-ordered range (`start <= end`). */
export function normalizeRange(anchor: Pos, cursor: Pos): SelectionRange {
	return isBefore(cursor, anchor)
		? { start: { ...cursor }, end: { ...anchor } }
		: { start: { ...anchor }, end: { ...cursor } };
}

/** True when the range covers no characters. */
export function isEmptyRange(range: SelectionRange): boolean {
	return range.start.line === range.end.line && range.start.col === range.end.col;
}

/** Extract the selected text, joining across lines with `\n`. */
export function getSelectedText(lines: string[], range: SelectionRange): string {
	const { start, end } = range;
	if (start.line === end.line) {
		return (lines[start.line] ?? "").slice(start.col, end.col);
	}
	const parts: string[] = [(lines[start.line] ?? "").slice(start.col)];
	for (let i = start.line + 1; i < end.line; i++) {
		parts.push(lines[i] ?? "");
	}
	parts.push((lines[end.line] ?? "").slice(0, end.col));
	return parts.join("\n");
}

/**
 * Remove the range from `lines`, returning a new array and the resulting cursor
 * position (always `range.start`). Does not mutate the input.
 */
export function deleteRange(lines: string[], range: SelectionRange): { lines: string[]; cursor: Pos } {
	const { start, end } = range;
	const next = lines.slice();
	if (start.line === end.line) {
		const line = lines[start.line] ?? "";
		next[start.line] = line.slice(0, start.col) + line.slice(end.col);
	} else {
		const merged = (lines[start.line] ?? "").slice(0, start.col) + (lines[end.line] ?? "").slice(end.col);
		next.splice(start.line, end.line - start.line + 1, merged);
	}
	return { lines: next, cursor: { line: start.line, col: start.col } };
}
