/**
 * `/switch-agent` persona picker: a bottom-anchored floating overlay listing
 * main-selectable discovered agents (availability !== "subagent", not in
 * `task.disabledAgents`). Selecting an entry live-switches the main-session
 * persona via `switchAgentPersona`; Esc closes without changes. Keyboard-only,
 * since mouse tracking is reserved for fullscreen overlays.
 */
import { type Component, type SelectItem, SelectList, type TUI } from "@oh-my-pi/pi-tui";
import type { AgentDefinition } from "../../task/types";
import { getSelectListTheme, theme } from "../theme/theme";
import { bottomBorder, row, topBorder } from "./overlay-box";

const STATUS_HINT = "Select an agent to switch the main-session persona";
const FOOTER_HINT = "↑/↓ agents · Enter switch persona · Esc close";
/** Fixed chrome rows: top border, status row, footer hint, bottom border. */
const CHROME_ROWS = 4;
/** Maximum list rows on short terminals. */
const MAX_VISIBLE = 20;

export interface AgentPersonaPickerCallbacks {
	onPick: (agent: AgentDefinition) => void;
	onCancel: () => void;
}

export class AgentPersonaPickerComponent implements Component {
	#tui: TUI;
	#list: SelectList;

	constructor(tui: TUI, agents: AgentDefinition[], callbacks: AgentPersonaPickerCallbacks) {
		this.#tui = tui;

		const items: SelectItem[] = agents.map(agent => ({
			value: agent.name,
			label: agent.name,
			description: agent.description,
		}));
		if (items.length === 0) {
			items.push({
				value: "__empty__",
				label: "No main-selectable agents",
				description: "All discovered agents are subagent-only or disabled",
			});
		}

		this.#list = new SelectList(items, Math.min(items.length, MAX_VISIBLE), getSelectListTheme());
		this.#list.onSelect = item => {
			if (item.value === "__empty__") return;
			const agent = agents.find(a => a.name === item.value);
			if (agent) callbacks.onPick(agent);
		};
		this.#list.onCancel = () => callbacks.onCancel();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		// Mouse tracking is off outside fullscreen overlays; drop any stray SGR
		// reports instead of feeding them to the list.
		if (data.startsWith("\x1b[<")) return;
		this.#list.handleInput(data);
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		this.#list.setMaxVisible(Math.max(3, Math.min(MAX_VISIBLE, termRows - CHROME_ROWS - 2)));

		const inner = Math.max(1, width - 4);
		const out: string[] = [];
		out.push(topBorder(width, "Switch Agent"));
		out.push(row(theme.fg("muted", ` ${STATUS_HINT}`), width));
		for (const line of this.#list.render(inner)) {
			out.push(row(line, width));
		}
		out.push(row(theme.fg("dim", FOOTER_HINT), width));
		out.push(bottomBorder(width));
		return out;
	}
}
