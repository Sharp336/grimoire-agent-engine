import {
	type Component,
	routeSelectListMouse,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
} from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../../theme/theme";

export class AuthGatewayChoiceDialog implements Component {
	readonly #selectList: SelectList;
	readonly #title: string;
	#listRowOffset = 0;

	constructor(title: string, items: readonly SelectItem[], onSelect: (value: string) => void, onCancel: () => void) {
		this.#title = title;
		this.#selectList = new SelectList(items, Math.max(1, Math.min(items.length, 8)), getSelectListTheme());
		this.#selectList.onSelect = item => onSelect(item.value);
		this.#selectList.onCancel = onCancel;
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#selectList, event, line - this.#listRowOffset);
	}

	render(width: number): readonly string[] {
		const lines: string[] = [theme.bold(this.#title)];
		this.#listRowOffset = lines.length;
		lines.push(...this.#selectList.render(width));
		lines.push(theme.fg("dim", "Enter select · Esc back/cancel"));
		return lines;
	}
}
