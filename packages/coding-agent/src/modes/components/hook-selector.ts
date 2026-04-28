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
	truncateToWidth,
	type TUI,
	type Component,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { matchesAppExternalEditor, matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { DynamicBorder } from "./dynamic-border";

const MIN_SPLIT_WIDTH = 96;
const PREVIEW_MIN_WIDTH = 30;

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
}

class OutlinedList extends Container {
	#lines: string[] = [];

	setLines(lines: string[]): void {
		this.#lines = lines;
		this.invalidate();
	}

	render(width: number): string[] {
		const borderColor = (text: string) => theme.fg("border", text);
		const horizontal = borderColor(theme.boxSharp.horizontal.repeat(Math.max(1, width)));
		const innerWidth = Math.max(1, width - 2);
		const content = this.#lines.map(line => {
			const normalized = replaceTabs(line);
			const fitted = truncateToWidth(normalized, innerWidth);
			const pad = Math.max(0, innerWidth - visibleWidth(fitted));
			return `${borderColor(theme.boxSharp.vertical)}${fitted}${padding(pad)}${borderColor(theme.boxSharp.vertical)}`;
		});
		return [horizontal, ...content, horizontal];
	}
}

class SelectorBody implements Component {
	#listLines: string[] = [];
	#outlinedList: OutlinedList | undefined;
	#preview: Markdown;

	constructor(outline: boolean) {
		if (outline) {
			this.#outlinedList = new OutlinedList();
		}
		this.#preview = new Markdown("", 0, 0, getMarkdownTheme(), { color: t => theme.fg("text", t) });
	}

	setListLines(lines: string[]): void {
		this.#listLines = lines;
		this.#outlinedList?.setLines(lines);
	}

	setPreviewText(text: string): void {
		this.#preview.setText(text);
	}

	invalidate(): void {
		this.#outlinedList?.invalidate();
		this.#preview.invalidate();
	}

	render(width: number): string[] {
		if (width >= MIN_SPLIT_WIDTH) {
			const split = this.#renderSplit(width);
			if (split) return split;
		}

		return this.#renderStacked(width);
	}

	#renderSplit(width: number): string[] | null {
		const separator = theme.fg("dim", ` ${theme.boxSharp.vertical} `);
		const separatorWidth = visibleWidth(separator);
		const available = Math.max(1, width - separatorWidth);
		const listWidth = Math.max(1, Math.floor(available * 0.45));
		const previewWidth = Math.max(1, available - listWidth);
		if (previewWidth < PREVIEW_MIN_WIDTH) {
			return null;
		}

		const listLines = this.#renderList(listWidth);
		const previewLines = this.#renderPreview(previewWidth);
		const lineCount = Math.max(listLines.length, previewLines.length);
		const lines: string[] = [];

		for (let i = 0; i < lineCount; i++) {
			const left = truncateToWidth(listLines[i] ?? "", listWidth);
			const leftPadding = padding(Math.max(0, listWidth - visibleWidth(left)));
			const right = truncateToWidth(previewLines[i] ?? "", previewWidth);
			lines.push(`${left}${leftPadding}${separator}${right}`);
		}

		return lines;
	}

	#renderStacked(width: number): string[] {
		const listLines = this.#renderList(width);
		const previewLines = this.#renderPreview(width);
		return [...listLines, "", ...previewLines];
	}

	#renderList(width: number): string[] {
		if (this.#outlinedList) {
			return this.#outlinedList.render(width);
		}

		return this.#listLines.map(line => truncateToWidth(replaceTabs(line), width));
	}

	#renderPreview(width: number): string[] {
		const header = theme.fg("dim", "Preview");
		const headerLine = truncateToWidth(header, width);
		const contentLines = this.#preview.render(width);
		return [headerLine, ...contentLines];
	}
}

export class HookSelectorComponent extends Container {
	#options: string[];
	#selectedIndex: number;
	#maxVisible: number;
	#selectorBody: SelectorBody;
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

		this.#selectorBody = new SelectorBody(Boolean(opts?.outline));
		this.addChild(this.#selectorBody);
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

		this.#selectorBody.setListLines(lines);
		this.#selectorBody.setPreviewText(this.#options[this.#selectedIndex] ?? "");
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
