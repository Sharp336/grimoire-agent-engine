/**
 * Generic selector component for hooks.
 * Displays a list of string options with keyboard navigation.
 */
import {
	Container,
	Markdown,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { matchesAppExternalEditor, matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { DynamicBorder } from "./dynamic-border";

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	initialIndex?: number;
	outline?: boolean;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	/**
	 * Upper bound on detail-pane rows in the outline picker. When > 0 the
	 * OutlinedList draws a separator + up to N wrapped rows below the list,
	 * sized dynamically to the focused option's actual wrap count. Set to 0
	 * (default) to disable the detail pane entirely.
	 *
	 * Callers (typically the extension UI controller) should derive this from
	 * available terminal rows so the picker cannot push the controls hint
	 * off-screen even when focused on the longest option.
	 */
	maxDetailRows?: number;
}

/** Minimum useful detail cap. Below this the pane wastes a separator row for almost no payload. */
const MIN_DETAIL_ROWS = 2;

// Layout-budget constants. The picker draws (top to bottom):
//   DynamicBorder · Spacer · Markdown title · Spacer ·
//   OutlinedList { top─ · N list rows · [separator─ · M detail rows] · bottom─ } ·
//   Spacer · controls hint · Spacer · DynamicBorder
// Non-list, non-detail rows therefore total: 2 borders + 4 spacers + hint = 7,
// plus the Markdown title (1-2 lines for typical questions; budget 2), plus
// the OutlinedList's own non-content rows (top + separator + bottom = 3 in
// detail mode, 2 without — over-budget by 1 in the non-detail branch, which
// gives a row of headroom). That sums to `PICKER_CHROME_ROWS` in detail mode.
const PICKER_CHROME_ROWS = 12;
/** Hard floor for the list window so the picker is always navigable. */
const MIN_LIST_ROWS = 4;
/** Hard ceiling for the list window — anything more starts to dominate big terminals. */
const MAX_LIST_ROWS = 15;
/** Smallest useful detail payload (separator + 3 wrapped lines is enough to convey context). */
const MIN_DETAIL_PANE_ROWS = 3;

/** Layout result for the outline-mode picker; both values are intended to be clamped, non-negative integers. */
export interface OutlinePickerLayout {
	/** List window size; floored so the list is always navigable. */
	maxVisible: number;
	/** Detail-pane row budget; 0 disables the pane when the terminal can't fit it. */
	maxDetailRows: number;
}

/**
 * Joint sizing of the outline picker's list window and detail pane against
 * the terminal's vertical budget. Guarantees that the worst-case rendered
 * height (focused option fully filling the detail budget) fits within
 * `terminalRows`, so the controls hint and bottom border can't be pushed
 * off-screen on small terminals.
 *
 * When the budget can't accommodate both `MIN_LIST_ROWS` and
 * `MIN_DETAIL_PANE_ROWS`, the detail pane is disabled (`maxDetailRows: 0`)
 * and the full budget goes to the list. Otherwise the detail pane consumes
 * every row not reserved for the navigable list window — there is no fixed
 * detail-pane cap beyond the terminal viewport itself.
 */
export function computeOutlinePickerLayout(terminalRows: number | undefined): OutlinePickerLayout {
	const rows = Math.max(MIN_LIST_ROWS, terminalRows ?? 24);
	const budget = rows - PICKER_CHROME_ROWS;
	if (budget < MIN_LIST_ROWS + MIN_DETAIL_PANE_ROWS) {
		// Not enough room to host both. Keep the list, drop the detail pane.
		const maxVisible = Math.max(MIN_LIST_ROWS, Math.min(MAX_LIST_ROWS, budget));
		return { maxVisible, maxDetailRows: 0 };
	}
	const maxVisible = Math.max(MIN_LIST_ROWS, Math.min(MAX_LIST_ROWS, Math.floor(budget / 3)));
	const maxDetailRows = budget - maxVisible;
	return { maxVisible, maxDetailRows };
}

class OutlinedList extends Container {
	#lines: string[] = [];
	#detailLabel: string | undefined;
	#maxDetailRows = 0;

	setLines(lines: string[]): void {
		this.#lines = lines;
		this.invalidate();
	}

	/**
	 * Set the focused option's full text for the detail pane. Pass `undefined`
	 * (or an empty string) to suppress the pane. The render path also requires
	 * `setMaxDetailRows(n >= MIN_DETAIL_ROWS)` for the pane to appear.
	 */
	setDetailLabel(label: string | undefined): void {
		this.#detailLabel = label;
		this.invalidate();
	}

	/**
	 * Upper bound on detail-content rows (excludes the separator row). The
	 * detail pane is rendered at `min(actualWrapCount, maxDetailRows)` rows —
	 * short focused options shrink the pane, long ones grow it up to this cap.
	 * Set 0 to disable the pane entirely.
	 */
	setMaxDetailRows(rows: number): void {
		const next = Math.max(0, Math.trunc(rows));
		if (next === this.#maxDetailRows) return;
		this.#maxDetailRows = next;
		this.invalidate();
	}

	render(width: number): string[] {
		const borderColor = (text: string) => theme.fg("border", text);
		const horizontal = borderColor(theme.boxSharp.horizontal.repeat(Math.max(1, width)));
		const innerWidth = Math.max(1, width - 2);
		const fitInside = (line: string): string => {
			const normalized = replaceTabs(line);
			const fitted = truncateToWidth(normalized, innerWidth);
			const pad = Math.max(0, innerWidth - visibleWidth(fitted));
			return `${borderColor(theme.boxSharp.vertical)}${fitted}${padding(pad)}${borderColor(theme.boxSharp.vertical)}`;
		};
		const content = this.#lines.map(fitInside);
		const detailRows = this.#renderDetail(innerWidth);
		if (detailRows.length === 0) {
			return [horizontal, ...content, horizontal];
		}
		return [horizontal, ...content, horizontal, ...detailRows.map(fitInside), horizontal];
	}

	/**
	 * Build the variable-height detail rows for the focused option. Returns an
	 * empty array when the pane is disabled (no cap, no label, or label wraps
	 * to zero lines), in which case the caller skips the separator entirely so
	 * single-line focused options don't draw an empty pane.
	 *
	 * Each row is left-inset by 1 column; the caller pads the right with the
	 * vertical-border wrapper.
	 */
	#renderDetail(innerWidth: number): string[] {
		if (this.#maxDetailRows < MIN_DETAIL_ROWS) return [];
		const source = this.#detailLabel ?? "";
		if (source.length === 0) return [];
		const detailWidth = Math.max(1, innerWidth - 2); // 1-col inset on each side
		const wrapped = wrapTextWithAnsi(replaceTabs(source), detailWidth);
		// Skip the pane when the focused option already fits on the list row — the
		// detail copy would be redundant and would waste a separator row.
		if (wrapped.length <= 1) return [];
		const visibleCount = Math.min(wrapped.length, this.#maxDetailRows);
		const rows: string[] = [];
		for (let i = 0; i < visibleCount; i++) {
			let line = wrapped[i] ?? "";
			const isLastVisible = i === visibleCount - 1;
			const overflowed = wrapped.length > visibleCount;
			if (isLastVisible && overflowed) {
				// Join the remainder with single spaces and let truncateToWidth append the ellipsis.
				const remainder = wrapped.slice(i).join(" ");
				line = truncateToWidth(remainder, detailWidth);
			}
			rows.push(` ${line}`);
		}
		return rows;
	}
}

export class HookSelectorComponent extends Container {
	#options: string[];
	#selectedIndex: number;
	#maxVisible: number;
	#listContainer: Container | undefined;
	#outlinedList: OutlinedList | undefined;
	#onSelectCallback: (option: string) => void;
	#onCancelCallback: () => void;
	#titleComponent: Markdown;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;
	#onLeftCallback: (() => void) | undefined;
	#onRightCallback: (() => void) | undefined;
	#onExternalEditorCallback: (() => void) | undefined;
	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: HookSelectorOptions,
	) {
		super();

		this.#options = options;
		this.#selectedIndex = Math.min(opts?.initialIndex ?? 0, options.length - 1);
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = title;
		this.#onLeftCallback = opts?.onLeft;
		this.#onRightCallback = opts?.onRight;
		this.#onExternalEditorCallback = opts?.onExternalEditor;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.#titleComponent = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
		this.addChild(this.#titleComponent);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => this.#titleComponent.setText(`${this.#baseTitle} (${s}s)`),
				() => {
					opts?.onTimeout?.();
					// Auto-select current option on timeout (typically the first/recommended option)
					const selected = this.#options[this.#selectedIndex];
					if (selected) {
						this.#onSelectCallback(selected);
					} else {
						this.#onCancelCallback();
					}
				},
			);
		}

		if (opts?.outline) {
			this.#outlinedList = new OutlinedList();
			if (opts.maxDetailRows && opts.maxDetailRows >= 2) {
				this.#outlinedList.setMaxDetailRows(opts.maxDetailRows);
			}
			this.addChild(this.#outlinedList);
		} else {
			this.#listContainer = new Container();
			this.addChild(this.#listContainer);
		}
		this.addChild(new Spacer(1));
		const controlsHint = opts?.helpText ?? "up/down navigate  enter select  esc cancel";
		this.addChild(new Text(theme.fg("dim", controlsHint), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#updateList();
	}

	#updateList(): void {
		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), this.#options.length - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, this.#options.length);

		const mdTheme = getMarkdownTheme();
		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.#selectedIndex;
			const label = isSelected
				? renderInlineMarkdown(this.#options[i], mdTheme, t => theme.fg("accent", t))
				: renderInlineMarkdown(this.#options[i], mdTheme, t => theme.fg("text", t));
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			lines.push(prefix + label);
		}

		if (startIndex > 0 || endIndex < this.#options.length) {
			lines.push(theme.fg("dim", `  (${this.#selectedIndex + 1}/${this.#options.length})`));
		}
		if (this.#outlinedList) {
			this.#outlinedList.setLines(lines);
			// Pass the raw focused option (with checkbox/recommended suffix, without
			// the cursor prefix) through inline-markdown rendering so its detail
			// representation matches the list-row rendering one-for-one.
			const focused = this.#options[this.#selectedIndex];
			this.#outlinedList.setDetailLabel(
				focused === undefined
					? undefined
					: renderInlineMarkdown(focused, getMarkdownTheme(), t => theme.fg("text", t)),
			);
			return;
		}
		this.#listContainer?.clear();
		for (const line of lines) {
			this.#listContainer?.addChild(new Text(line, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		// Reset countdown on any interaction
		this.#countdown?.reset();

		if (matchesKey(keyData, "up") || keyData === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#updateList();
		} else if (matchesKey(keyData, "down") || keyData === "j") {
			this.#selectedIndex = Math.min(this.#options.length - 1, this.#selectedIndex + 1);
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#options[this.#selectedIndex];
			if (selected) this.#onSelectCallback(selected);
		} else if (matchesKey(keyData, "left")) {
			this.#onLeftCallback?.();
		} else if (matchesKey(keyData, "right")) {
			this.#onRightCallback?.();
		} else if (this.#onExternalEditorCallback && matchesAppExternalEditor(keyData)) {
			this.#onExternalEditorCallback();
		} else if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
		}
	}

	dispose(): void {
		this.#countdown?.dispose();
	}
}
