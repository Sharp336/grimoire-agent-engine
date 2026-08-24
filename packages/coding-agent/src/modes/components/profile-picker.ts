/**
 * Profile picker opened by `/profile` (bare): a bottom-anchored floating
 * overlay listing the configured profiles plus "off". Selecting one activates
 * it immediately via the caller-supplied callback.
 */
import { type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

const PROFILE_SELECTOR_MAX_VISIBLE = 12;

export interface ProfilePickerEntry {
	/** Profile name, or "off" for the disable row. */
	name: string;
	/** Description shown on the row (profile description or role count). */
	description?: string;
}

/**
 * Floating profile selector. `onSelect` receives the profile name (or "off")
 * and is responsible for persisting activation and dismissing the overlay.
 */
export class ProfilePickerComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		entries: readonly ProfilePickerEntry[],
		currentProfile: string,
		onSelect: (name: string) => void,
		onCancel: () => void,
	) {
		super("Select Profile");
		const byValue = new Map<string, string>();
		const items: SelectItem[] = entries.map(entry => {
			byValue.set(entry.name, entry.name);
			return {
				value: entry.name,
				label: entry.name,
				description: entry.description,
			};
		});

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), PROFILE_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
		);
		const currentIndex = entries.findIndex(entry => entry.name === currentProfile);
		if (currentIndex >= 0) this.#selectList.setSelectedIndex(currentIndex);
		this.#selectList.onSelect = item => {
			const name = byValue.get(item.value);
			if (name !== undefined) onSelect(name);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
	}

	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
