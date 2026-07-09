import {
	type Component,
	matchesKey,
	padding,
	routeSgrMouseInput,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { highlightCode, theme } from "../theme/theme";
import type { CopyTarget } from "../utils/copy-targets";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { keyHint, rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

/** Minimum rows reserved for the tree even on short terminals. */
const MIN_TREE_ROWS = 3;
/** Fixed chrome rows: top border, two dividers, footer, bottom border. */
const CHROME_ROWS = 5;

export interface CopySelectorCallbacks {
	/** A copy target was chosen — copy its `content`. */
	onPick: (target: CopyTarget) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

interface FlatNode {
	target: CopyTarget;
	depth: number;
	/** Last among its siblings (drives └─ vs ├─). */
	isLast: boolean;
	/** Per-ancestor flag: does ancestor at that level have a following sibling? */
	ancestorHasNext: boolean[];
}

/** Render one tree connector as exactly three cells (e.g. "├─ ", "└─ ", "|--"). */
function connectorCells(symbol: string): string {
	const chars = Array.from(symbol);
	return (chars[0] ?? " ") + (chars[1] ?? theme.tree.horizontal) + (chars[2] ?? " ");
}

/** The 3-cell ancestor gutter: a vertical guide when the ancestor continues. */
function gutterCells(hasNext: boolean): string {
	return `${hasNext ? theme.tree.vertical : " "}  `;
}

/**
 * Fullscreen `/copy` picker rendered as a `/tree`-style tree inside one
 * outlined box: a title, the tree of copy targets (recent assistant messages
 * with their code blocks nested beneath), a live preview of the highlighted
 * node, and a keybinding footer. Every node copies its `content` on Enter.
 *
 * Mouse behaviour: hover updates the preview; a left click selects (moves
 * the keyboard cursor) without copying; wheel scrolls three nodes and clears
 * hover; Enter is the sole commit gesture, resolving `hoverId ?? cursorId`.
 */
export class CopySelectorComponent implements Component {
	/** Flat list built once from the immutable target tree. */
	#flat: FlatNode[];
	#cursorId: string;
	#hoverId: string | undefined;
	/** Frame-local 0-based row → CopyTarget, rebuilt on every render. */
	#targetByScreenRow = new Map<number, CopyTarget>();
	#lastSourceTarget?: CopyTarget;
	#lastSource?: string;
	#treeRows = MIN_TREE_ROWS;
	// Reused across renders to wrap preview content to the pane width.
	#previewText = new Text("", 0, 0);

	constructor(
		roots: CopyTarget[],
		private readonly callbacks: CopySelectorCallbacks,
	) {
		this.#flat = this.#buildFlat(roots);
		this.#cursorId = roots[0]?.id ?? "";
	}

	invalidate(): void {
		this.#lastSourceTarget = undefined;
		this.#lastSource = undefined;
	}

	#buildFlat(roots: CopyTarget[]): FlatNode[] {
		const out: FlatNode[] = [];
		const walk = (nodes: CopyTarget[], depth: number, ancestorHasNext: boolean[]) => {
			nodes.forEach((target, i) => {
				const isLast = i === nodes.length - 1;
				out.push({ target, depth, isLast, ancestorHasNext });
				if (target.children?.length) walk(target.children, depth + 1, [...ancestorHasNext, !isLast]);
			});
		};
		walk(roots, 0, []);
		return out;
	}

	/**
	 * Route an SGR mouse report. All events are consumed (return true); no
	 * mouse path ever calls `onPick`. Left click selects (moves cursor, clears
	 * hover). Wheel scrolls three nodes and clears hover. Motion sets hover.
	 */
	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => {
			const flat = this.#flat;

			if (event.wheel !== null) {
				// Wheel: clear hover, move keyboard cursor by three, clamped.
				this.#hoverId = undefined;
				if (flat.length > 0) {
					const idx = Math.max(
						0,
						flat.findIndex(n => n.target.id === this.#cursorId),
					);
					const next = Math.max(0, Math.min(flat.length - 1, idx + event.wheel * 3));
					this.#cursorId = flat[next]!.target.id;
				}
				return true;
			}

			if (event.motion) {
				const target = this.#targetByScreenRow.get(event.row);
				this.#hoverId = target?.id;
				return true;
			}

			// All non-motion, non-wheel events: left click selects cursor, everything
			// else is consumed silently. No path reaches onPick.
			if (event.leftClick) {
				const target = this.#targetByScreenRow.get(event.row);
				if (target) {
					this.#cursorId = target.id;
					this.#hoverId = undefined;
				}
			}
			// Release, middle, right, clicks outside mapped rows: consume without effect.
			return true;
		});
	}

	handleInput(keyData: string): void {
		// Route SGR mouse input before any keyboard handling.
		if (this.#handleMouse(keyData)) return;

		if (matchesSelectCancel(keyData)) {
			this.#hoverId = undefined;
			this.callbacks.onCancel();
			return;
		}

		const flat = this.#flat;
		if (flat.length === 0) return;

		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		// Non-Enter keyboard clears hover so the cursor drives the preview again.
		if (!isEnter) {
			this.#hoverId = undefined;
		}

		const idx = Math.max(
			0,
			flat.findIndex(n => n.target.id === this.#cursorId),
		);

		if (matchesSelectUp(keyData)) {
			this.#cursorId = flat[idx === 0 ? flat.length - 1 : idx - 1]!.target.id;
		} else if (matchesSelectDown(keyData)) {
			this.#cursorId = flat[idx === flat.length - 1 ? 0 : idx + 1]!.target.id;
		} else if (matchesSelectPageUp(keyData)) {
			this.#cursorId = flat[Math.max(0, idx - this.#treeRows)]!.target.id;
		} else if (matchesSelectPageDown(keyData)) {
			this.#cursorId = flat[Math.min(flat.length - 1, idx + this.#treeRows)]!.target.id;
		} else if (isEnter) {
			// Resolve the target driving the preview: hover takes precedence.
			const resolvedId = this.#hoverId ?? this.#cursorId;
			const target = flat.find(n => n.target.id === resolvedId)?.target ?? flat[idx]!.target;
			// Synchronize cursor to the committed target, clear hover.
			this.#cursorId = target.id;
			this.#hoverId = undefined;
			if (target.content !== undefined) this.callbacks.onPick(target);
		}
	}

	#renderTree(
		width: number,
		flat: FlatNode[],
		cursorIdx: number,
		rows: number,
		frameRowOffset: number,
		heightLimit: number,
		sliceOffset: number,
	): string[] {
		const inner = Math.max(0, width - 4);
		const start = Math.max(0, Math.min(cursorIdx - Math.floor(rows / 2), Math.max(0, flat.length - rows)));
		const out: string[] = [];
		for (let r = 0; r < rows; r++) {
			const i = start + r;
			const node = flat[i];
			if (!node) {
				out.push(row("", width));
				continue;
			}
			const target = node.target;
			// Convert frame row to physical screen row, accounting for the TUI's
			// bottom-anchor slice (overlayLines.slice(len - maxHeight)) which drops
			// rows from the TOP when the component renders taller than the terminal.
			// screenRow < 0 means the row was sliced off and is not addressable.
			const screenRow = frameRowOffset + r - sliceOffset;
			if (screenRow >= 0 && screenRow < heightLimit) {
				this.#targetByScreenRow.set(screenRow, target);
			}

			const isSelected = target.id === this.#cursorId;
			const isHovered = !isSelected && target.id === this.#hoverId;

			let prefix = "";
			for (let l = 0; l < node.depth - 1; l++) prefix += gutterCells(node.ancestorHasNext[l]!);
			if (node.depth > 0) prefix += connectorCells(node.isLast ? theme.tree.last : theme.tree.branch);

			// Three-cell leading slot: accent cursor, muted gutter for hover, blank otherwise.
			const cursorCell = isSelected ? "❯ " : isHovered ? "▎ " : "  ";
			const hint = target.hint ?? "";
			const hintWidth = hint ? visibleWidth(hint) + 2 : 0;
			const used = visibleWidth(cursorCell) + visibleWidth(prefix);
			const labelPlain = truncateToWidth(target.label, Math.max(1, inner - used - hintWidth));

			let left: string;
			if (isSelected) {
				left =
					theme.fg("accent", cursorCell) + theme.fg("dim", prefix) + theme.bold(theme.fg("accent", labelPlain));
			} else if (isHovered) {
				// Muted gutter only; label text is otherwise unchanged.
				left = theme.fg("muted", cursorCell) + theme.fg("dim", prefix) + labelPlain;
			} else {
				left = cursorCell + theme.fg("dim", prefix) + labelPlain;
			}

			const gap = Math.max(1, inner - used - visibleWidth(labelPlain) - visibleWidth(hint));
			out.push(row(left + padding(gap) + (hint ? theme.fg("dim", hint) : ""), width));
		}
		return out;
	}

	#renderPreview(width: number, target: CopyTarget | undefined, rows: number): string[] {
		const out: string[] = [];
		const hint = target?.hint;
		out.push(row(theme.fg("dim", `Preview${hint ? ` · ${hint}` : ""}`), width));

		const contentRows = rows - 1;
		if (!target || contentRows <= 0) {
			while (out.length < rows) out.push(row("", width));
			return out;
		}

		// Code/command previews are syntax-highlighted; everything else is shown
		// as plain text. Both are wrapped (not hard-truncated) to the pane width.
		const isCode = target.language !== undefined;
		let source: string;
		if (target === this.#lastSourceTarget && this.#lastSource !== undefined) {
			source = this.#lastSource;
		} else {
			source = isCode
				? highlightCode(replaceTabs(target.preview), target.language).join("\n")
				: replaceTabs(target.preview);
			this.#lastSourceTarget = target;
			this.#lastSource = source;
		}
		this.#previewText.setText(source);
		const wrapped = this.#previewText.render(Math.max(1, width - 4));

		const hasMore = wrapped.length > contentRows;
		const visibleCount = hasMore ? contentRows - 1 : Math.min(wrapped.length, contentRows);
		for (let k = 0; k < contentRows; k++) {
			if (k < visibleCount) {
				out.push(row(isCode ? wrapped[k]! : theme.fg("muted", wrapped[k]!), width));
			} else if (k === visibleCount && hasMore) {
				out.push(row(theme.fg("dim", `… ${wrapped.length - visibleCount} more lines`), width));
			} else {
				out.push(row("", width));
			}
		}
		return out;
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const flat = this.#flat;
		const cursorIdx = Math.max(
			0,
			flat.findIndex(n => n.target.id === this.#cursorId),
		);

		const available = Math.max(MIN_TREE_ROWS + 1, height - CHROME_ROWS);
		const treeRows = Math.max(1, Math.min(flat.length, Math.floor(available / 2)));
		this.#treeRows = treeRows;
		const previewRows = Math.max(1, available - treeRows);

		// The component renders CHROME_ROWS + treeRows + previewRows lines.
		// When the terminal is shorter than that, the TUI's bottom-anchor compositor
		// slices the same number of rows off the TOP. sliceOffset tracks how many
		// frame rows are hidden so #renderTree maps targets to physical screen rows.
		const totalLines = CHROME_ROWS + treeRows + previewRows;
		const sliceOffset = Math.max(0, totalLines - height);

		// Rebuild the screen-row map on every frame; tree starts at frame row 1
		// (row 0 is the top border).
		this.#targetByScreenRow.clear();
		const treeLines = this.#renderTree(width, flat, cursorIdx, treeRows, 1, height, sliceOffset);

		// Preview follows hover when the pointer is over a tree node, cursor otherwise.
		const previewId = this.#hoverId ?? this.#cursorId;
		const previewTarget = flat.find(n => n.target.id === previewId)?.target ?? flat[cursorIdx]?.target;

		const footer = [
			rawKeyHint("↑↓/wheel", "move"),
			rawKeyHint("hover", "preview"),
			rawKeyHint("click", "select"),
			keyHint("tui.select.confirm", "copy") + theme.fg("dim", " · ") + keyHint("tui.select.cancel", "quit"),
		].join(theme.fg("dim", " · "));

		return [
			topBorder(width, "Copy to clipboard"),
			...treeLines,
			divider(width),
			...this.#renderPreview(width, previewTarget, previewRows),
			divider(width),
			row(footer, width),
			bottomBorder(width),
		];
	}
}
