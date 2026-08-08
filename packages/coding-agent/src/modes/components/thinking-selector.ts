import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../../thinking";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		currentLevel: ConfiguredThinkingLevel | undefined,
		availableLevels: ConfiguredThinkingLevel[],
		onSelect: (level: ConfiguredThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingLevels: SelectItem[] = availableLevels.map(getConfiguredThinkingLevelMetadata);

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme());

		// Preselect current level
		const currentIndex =
			currentLevel === undefined ? -1 : thinkingLevels.findIndex(item => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as ConfiguredThinkingLevel);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
