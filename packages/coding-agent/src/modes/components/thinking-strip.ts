/**
 * Horizontal thinking-effort strip shown after a session-only model pick
 * (alt+p / `/switch`) — the same chip idiom as the model hub's thinking
 * strip. Hosted as a bottom-anchored overlay; keyboard-only (mouse tracking
 * is reserved for fullscreen overlays). Left/Right move the selection, Enter
 * applies the highlighted level, Esc keeps the fallback level.
 */
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../../thinking";
import { theme } from "../theme/theme";
import { matchesSelectCancel } from "../utils/keybinding-matchers";
import { thinkingLevelGlyph } from "./model-browser";
import { bottomBorder, row, topBorder } from "./overlay-box";

const FOOTER_HINT = "←/→ thinking level · Enter apply · Esc keep current";

export class ThinkingStripComponent implements Component {
	#modelLabel: string;
	#levels: ConfiguredThinkingLevel[];
	#index: number;
	#onSelect: (level: ConfiguredThinkingLevel) => void;
	#onCancel: () => void;
	#inputLocked = false;

	constructor(
		modelLabel: string,
		levels: ConfiguredThinkingLevel[],
		preselect: ConfiguredThinkingLevel,
		onSelect: (level: ConfiguredThinkingLevel) => void,
		onCancel: () => void,
	) {
		this.#modelLabel = modelLabel;
		this.#levels = levels;
		const index = levels.indexOf(preselect);
		this.#index = index >= 0 ? index : 0;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.#inputLocked) return;
		if (matchesSelectCancel(data)) {
			this.#inputLocked = true;
			this.#onCancel();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || data === "\r") {
			const level = this.#levels[this.#index];
			if (level !== undefined) {
				this.#inputLocked = true;
				this.#onSelect(level);
			}
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
			this.#index = (this.#index + this.#levels.length - 1) % this.#levels.length;
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.#index = (this.#index + 1) % this.#levels.length;
		}
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		// Horizontal window (the hub strip idiom): once the chips overflow,
		// drop leading chips behind a dim ellipsis so the selected chip stays
		// visible while cycling right. row() insets content by 2 per side.
		const chips = this.#levels.map(level => {
			const label = getConfiguredThinkingLevelMetadata(level).label;
			const glyph = thinkingLevelGlyph(level);
			return glyph ? `${theme.fg("accent", glyph)} ${label}` : label;
		});
		const chipWidths = chips.map((chip, i) => visibleWidth(` ${chip} `) + (i === this.#index ? 2 : 0) + 1);
		const selectedChipWidth = chipWidths[this.#index] ?? 1;
		const separator = ` ${theme.fg("dim", "→")} `;
		const modelBudget = Math.max(
			0,
			contentWidth - selectedChipWidth - (this.#index > 0 ? 2 : 0) - visibleWidth(separator),
		);
		const prefix =
			modelBudget > 0 ? `${truncateToWidth(theme.fg("accent", this.#modelLabel), modelBudget)}${separator}` : "";
		const available = Math.max(1, contentWidth - visibleWidth(prefix));
		const startFor = (target: number): number => {
			let start = 0;
			while (start < target) {
				let sum = start > 0 ? 2 : 0;
				for (let i = start; i <= target; i++) sum += chipWidths[i] ?? 0;
				if (sum <= available) break;
				start++;
			}
			return start;
		};
		let start = startFor(Math.min(this.#index + 1, chips.length - 1));
		if (start > this.#index) start = startFor(this.#index);

		let line = prefix;
		if (start > 0 && available >= selectedChipWidth + 2) line += theme.fg("dim", "… ");
		for (let i = start; i < chips.length; i++) {
			const body = ` ${chips[i]} `;
			line +=
				i === this.#index
					? theme.bg("selectedBg", `${theme.fg("accent", "[")}${body}${theme.fg("accent", "]")}`)
					: body;
			line += " ";
		}

		return [
			topBorder(width, "Thinking"),
			row(truncateToWidth(line, contentWidth), width),
			row(theme.fg("dim", FOOTER_HINT), width),
			bottomBorder(width),
		];
	}
}
