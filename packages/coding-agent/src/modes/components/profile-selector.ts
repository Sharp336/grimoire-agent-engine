import { Container, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

export interface ProfileSelectorCallbacks {
	onPick: (profileName: string) => void;
	onCancel: () => void;
}

/**
 * Interactive profile picker: lists saved profiles with keyboard navigation
 * and fuzzy search. Rendered as an editor-slot selector (like /thinking).
 */
export class ProfileSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(profileNames: string[], callbacks: ProfileSelectorCallbacks) {
		super();

		const items: SelectItem[] = profileNames.map(name => ({
			value: name,
			label: name,
		}));

		this.addChild(new DynamicBorder());

		this.#selectList = new SelectList(
			items.length > 0
				? items
				: [{ value: "", label: "No profiles saved. Use /profiles save <name> to create one." }],
			Math.min(Math.max(items.length, 1), 15),
			getSelectListTheme(),
		);

		this.#selectList.onSelect = item => {
			if (item.value) callbacks.onPick(item.value);
		};

		this.#selectList.onCancel = () => {
			callbacks.onCancel();
		};

		this.addChild(this.#selectList);

		this.addChild(new DynamicBorder());
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}
