import {
	Container,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	Spacer,
	TruncatedText,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { fuzzyFilter } from "../../utils/fuzzy";
import { DynamicBorder } from "./dynamic-border";

export interface SearchableStringSelectorOptions {
	maxVisible?: number;
	helpText?: string;
}

/**
 * Selector for string options with an inline search field.
 */
export class SearchableStringSelectorComponent extends Container {
	#searchInput = new Input();
	#listContainer = new Container();
	#filteredOptions: string[];
	#selectedIndex = 0;
	#maxVisible: number;
	#helpText: string;

	constructor(
		readonly title: string,
		readonly options: string[],
		readonly onSelect: (option: string) => void,
		readonly onCancel: () => void,
		selectorOptions: SearchableStringSelectorOptions = {},
	) {
		super();
		this.#filteredOptions = options;
		this.#maxVisible = Math.max(3, selectorOptions.maxVisible ?? 12);
		this.#helpText = selectorOptions.helpText ?? "type to search  up/down navigate  enter select  esc cancel";

		this.#searchInput.onSubmit = () => {
			this.#selectCurrent();
		};

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.fg("dim", this.#helpText), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#updateList();
	}

	#selectCurrent(): void {
		const selected = this.#filteredOptions[this.#selectedIndex];
		if (selected) {
			this.onSelect(selected);
		}
	}

	#filterOptions(query: string): void {
		this.#filteredOptions = fuzzyFilter(this.options, query, option => option);
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredOptions.length - 1));
		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();

		if (this.#filteredOptions.length === 0) {
			const query = this.#searchInput.getValue().trim();
			const message = query ? `No matches for "${replaceTabs(query)}"` : "No options available";
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.#selectedIndex - Math.floor(this.#maxVisible / 2),
				this.#filteredOptions.length - this.#maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, this.#filteredOptions.length);

		for (let i = startIndex; i < endIndex; i++) {
			const option = this.#filteredOptions[i];
			if (!option) continue;

			const isSelected = i === this.#selectedIndex;
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const label = replaceTabs(option);
			const line = cursor + (isSelected ? theme.fg("accent", label) : theme.fg("text", label));
			this.#listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.#filteredOptions.length) {
			const countText = `  (${this.#selectedIndex + 1}/${this.#filteredOptions.length})`;
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", countText), 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const hasOptions = this.#filteredOptions.length > 0;
		if (matchesKey(keyData, "up")) {
			if (!hasOptions) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#updateList();
			return;
		}

		if (matchesKey(keyData, "down")) {
			if (!hasOptions) return;
			this.#selectedIndex = Math.min(this.#filteredOptions.length - 1, this.#selectedIndex + 1);
			this.#updateList();
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			if (!hasOptions) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#maxVisible);
			this.#updateList();
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			if (!hasOptions) return;
			this.#selectedIndex = Math.min(this.#filteredOptions.length - 1, this.#selectedIndex + this.#maxVisible);
			this.#updateList();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrent();
			return;
		}

		if (matchesSelectCancel(keyData)) {
			this.onCancel();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#filterOptions(this.#searchInput.getValue());
	}
}
