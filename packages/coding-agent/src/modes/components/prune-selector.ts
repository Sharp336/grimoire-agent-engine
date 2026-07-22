import { type Component, matchesKey, padding, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { keyHint, rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

/** Minimum rows reserved for the list even on short terminals. */
const MIN_LIST_ROWS = 3;
/** Fixed chrome rows: top border, two dividers, footer, bottom border. */
const CHROME_ROWS = 5;

export interface PruneItem {
	id: string;
	toolName: string;
	tokens: number;
	preview: string;
}

export interface PruneSelectorCallbacks {
	/** Confirm: prune every checked id, or — if none are checked — the row under the cursor. */
	onConfirm: (ids: string[]) => void;
	/** The picker was dismissed without pruning anything. */
	onCancel: () => void;
}

/**
 * Fullscreen `/prune` picker: a flat, chronological list of every tool
 * output currently in context, a live preview of the highlighted one, and a
 * multi-select checkbox column. Modeled on `CopySelectorComponent` (same box
 * chrome, preview pane, and sizing) but flat rather than tree-shaped, and
 * checkbox-driven rather than single-pick.
 */
export class PruneSelectorComponent implements Component {
	#items: PruneItem[];
	#cursorId: string;
	#checked = new Set<string>();
	#lastSourceId?: string;
	#lastSource?: string;
	#listRows = MIN_LIST_ROWS;
	// Reused across renders to wrap preview content to the pane width.
	#previewText = new Text("", 0, 0);

	constructor(
		items: PruneItem[],
		private readonly callbacks: PruneSelectorCallbacks,
	) {
		this.#items = items;
		this.#cursorId = items[0]?.id ?? "";
	}

	invalidate(): void {
		this.#lastSourceId = undefined;
		this.#lastSource = undefined;
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}

		const items = this.#items;
		if (items.length === 0) return;
		const idx = Math.max(
			0,
			items.findIndex(n => n.id === this.#cursorId),
		);

		if (matchesSelectUp(keyData)) {
			this.#cursorId = items[idx === 0 ? items.length - 1 : idx - 1]!.id;
		} else if (matchesSelectDown(keyData)) {
			this.#cursorId = items[idx === items.length - 1 ? 0 : idx + 1]!.id;
		} else if (matchesSelectPageUp(keyData)) {
			this.#cursorId = items[Math.max(0, idx - this.#listRows)]!.id;
		} else if (matchesSelectPageDown(keyData)) {
			this.#cursorId = items[Math.min(items.length - 1, idx + this.#listRows)]!.id;
		} else if (keyData === " ") {
			const id = items[idx]!.id;
			if (this.#checked.has(id)) this.#checked.delete(id);
			else this.#checked.add(id);
		} else if (keyData === "a") {
			if (this.#checked.size === items.length) this.#checked.clear();
			else for (const item of items) this.#checked.add(item.id);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const cursorId = items[idx]!.id;
			this.callbacks.onConfirm(this.#checked.size > 0 ? [...this.#checked] : [cursorId]);
		}
	}

	#renderList(width: number, items: PruneItem[], cursorIdx: number, rows: number): string[] {
		const inner = Math.max(0, width - 4);
		const start = Math.max(0, Math.min(cursorIdx - Math.floor(rows / 2), Math.max(0, items.length - rows)));
		const out: string[] = [];
		for (let r = 0; r < rows; r++) {
			const i = start + r;
			const item = items[i];
			if (!item) {
				out.push(row("", width));
				continue;
			}
			const isSelected = i === cursorIdx;
			const isChecked = this.#checked.has(item.id);

			const box = isChecked ? theme.fg("accent", "[x] ") : "[ ] ";
			const cursor = isSelected ? "❯ " : "  ";
			const hint = `~${item.tokens} tok`;
			const hintWidth = visibleWidth(hint) + 2;
			const used = visibleWidth(box) + visibleWidth(cursor);
			const labelPlain = truncateToWidth(item.toolName, Math.max(1, inner - used - hintWidth));
			const left = isSelected
				? box + theme.fg("accent", cursor) + theme.bold(theme.fg("accent", labelPlain))
				: box + cursor + labelPlain;
			const gap = Math.max(1, inner - used - visibleWidth(labelPlain) - visibleWidth(hint));
			out.push(row(left + padding(gap) + theme.fg("dim", hint), width));
		}
		return out;
	}

	#renderPreview(width: number, item: PruneItem | undefined, rows: number): string[] {
		const out: string[] = [];
		out.push(row(theme.fg("dim", `Preview${item ? ` · ${item.toolName}` : ""}`), width));

		const contentRows = rows - 1;
		if (!item || contentRows <= 0) {
			while (out.length < rows) out.push(row("", width));
			return out;
		}

		// Tool-output previews are never code, so — unlike the copy picker —
		// there is no syntax-highlighting branch; wrap plain text to the pane width.
		let source: string;
		if (item.id === this.#lastSourceId && this.#lastSource !== undefined) {
			source = this.#lastSource;
		} else {
			source = replaceTabs(item.preview);
			this.#lastSourceId = item.id;
			this.#lastSource = source;
		}
		this.#previewText.setText(source);
		const wrapped = this.#previewText.render(Math.max(1, width - 4));

		const hasMore = wrapped.length > contentRows;
		const visibleCount = hasMore ? contentRows - 1 : Math.min(wrapped.length, contentRows);
		for (let k = 0; k < contentRows; k++) {
			if (k < visibleCount) {
				out.push(row(theme.fg("muted", wrapped[k]!), width));
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
		const items = this.#items;
		const cursorIdx = Math.max(
			0,
			items.findIndex(n => n.id === this.#cursorId),
		);
		const selected = items[cursorIdx];

		const available = Math.max(MIN_LIST_ROWS + 1, height - CHROME_ROWS);
		const listRows = Math.max(1, Math.min(items.length, Math.floor(available / 2)));
		this.#listRows = listRows;
		const previewRows = Math.max(1, available - listRows);

		const footer = [
			rawKeyHint("↑↓", "move"),
			rawKeyHint("space", "select"),
			rawKeyHint("a", "all"),
			keyHint("tui.select.confirm", "prune"),
			keyHint("tui.select.cancel", "quit"),
		].join(theme.fg("dim", " · "));

		return [
			topBorder(width, "Prune tool outputs"),
			...this.#renderList(width, items, cursorIdx, listRows),
			divider(width),
			...this.#renderPreview(width, selected, previewRows),
			divider(width),
			row(footer, width),
			bottomBorder(width),
		];
	}
}
