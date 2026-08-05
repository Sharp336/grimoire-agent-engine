/**
 * Fullscreen `/advisor configure` overlay: a mouse- and keyboard-driven picker
 * for the agent definitions that observe this session as advisors (the
 * `advisor.agents` setting). Advisors are ordinary agents the user opts into —
 * there is no WATCHDOG.yml roster to edit.
 *
 * It paints the entire alternate screen from row 0 (so SGR mouse rows index
 * directly into the rendered frame) using the shared {@link ./overlay-box} chrome.
 * The list screen is a two-pane split (the `/extensions` idiom): a clickable
 * checkbox list of the discovered agent roster on the left, and a scrollable
 * preview of the highlighted agent (description, source, live status/usage when
 * selected) on the right, filling the free space.
 *
 * The list is backed by {@link SelectList}. Toggling mutates the in-memory
 * selection; "Save & apply" persists the roster-ordered selection to
 * `advisor.agents` (the same Settings API and scope the agent dashboard uses
 * for `task.disabledAgents`) and rebuilds the live advisors via the host
 * `save` callback.
 */
import {
	type Component,
	type MouseRoutable,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import type { PerAdvisorStat } from "../../session/agent-session";
import type { AgentDefinition, AgentSource } from "../../task/types";
import { getSelectListTheme, theme } from "../theme/theme";
import { bottomBorder, dividerSplit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";

/** Host callbacks: live-runtime effects (and the status line) flow through these. */
export interface AdvisorAgentsPickerCallbacks {
	/** Rebuild the live advisor roster from the persisted selection. */
	save: (names: string[]) => Promise<void> | void;
	/** Tear down the overlay and restore the editor. */
	close: () => void;
	requestRender: () => void;
	/** Surface a transient status/warning line to the user. */
	notify: (message: string) => void;
	/** Live advisor usage stats; lets rows and the preview show status per selected agent. */
	getAdvisorStats?: () => PerAdvisorStat[];
}

export interface AdvisorAgentsPickerDeps {
	settings: Settings;
	/** The discovered agent roster; displayed (and persisted) in discovery order. */
	agents: readonly AgentDefinition[];
	/** Model label of the legacy default advisor, shown when nothing is selected. */
	defaultModelLabel?: string;
}

const SOURCE_LABEL: Record<AgentSource, string> = {
	project: "Project",
	user: "User",
	bundled: "Bundled",
};

const PREVIEW_WIDTH = 60;

function previewLine(text: string | undefined): string {
	if (!text?.trim()) return "";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Soft-wrap plain text to `width`, returning at least one (possibly empty) line. */
function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

const STATUS_GLYPH: Record<string, string> = {
	running: "●",
	paused: "○",
	no_model: "○",
	quota_exhausted: "✕",
	error: "✕",
};

const STATUS_LABEL: Record<string, string> = {
	running: "running",
	paused: "off",
	no_model: "no model",
	quota_exhausted: "quota exhausted",
	error: "error",
};

const SAVE_ACTION = "__save";
const CLOSE_ACTION = "__close";

/**
 * Fullscreen advisor-picker overlay. Implements {@link Component} directly
 * (rather than extending Container) so it owns the whole frame and the mouse
 * geometry needed to make every row clickable.
 */
export class AdvisorAgentsPickerComponent implements Component {
	#settings: Settings;
	#agents: readonly AgentDefinition[];
	#agentByName: Map<string, AgentDefinition>;
	#defaultModelLabel: string | undefined;
	#cb: AdvisorAgentsPickerCallbacks;
	#selected: Set<string>;
	#dirty = false;

	/** The interactive element for the current screen. */
	#active: Component = new SelectList([], 1, getSelectListTheme());
	#footerHint = "";
	#previewScroll = 0;
	/** Highlighted list row index; restored after every rebuild so toggles don't jump. */
	#cursorIndex = 0;

	// Frame geometry from the last render (the frame paints from screen row 0,
	// so SGR `event.row`/`event.col` — already 0-based — index it directly).
	#bodyRowStart = 0;
	#dividerCol = 0;

	constructor(deps: AdvisorAgentsPickerDeps, callbacks: AdvisorAgentsPickerCallbacks) {
		this.#settings = deps.settings;
		this.#agents = deps.agents;
		this.#agentByName = new Map(deps.agents.map(agent => [agent.name, agent]));
		this.#defaultModelLabel = deps.defaultModelLabel;
		this.#cb = callbacks;
		// Checkbox state starts from the persisted selection; names that are no
		// longer on the roster are dropped so save writes a self-healing list.
		this.#selected = new Set(this.#settings.get("advisor.agents").filter(name => this.#agentByName.has(name)));
		this.#showList();
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const bodyRows = Math.max(3, height - 4);
		const title = `Advisor roster · agents observing this session${this.#dirty ? "  ● unsaved" : ""}`;
		const out: string[] = [];

		const sidebarWidth = Math.max(22, Math.min(42, Math.floor(width * 0.34)));
		this.#dividerCol = sidebarWidth + 3;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const sidebar = this.#active.render(sidebarWidth);
		const preview = this.#previewWindow(bodyWidth, bodyRows);
		out.push(topBorderSplit(width, title, sidebarWidth));
		this.#bodyRowStart = out.length;
		for (let i = 0; i < bodyRows; i++) {
			out.push(splitRow(sidebar[i] ?? "", preview[i] ?? "", width, sidebarWidth));
		}
		out.push(dividerSplit(width, sidebarWidth));

		out.push(row(theme.fg("dim", this.#footerHint), width));
		out.push(bottomBorder(width));
		return out;
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		this.#active.handleInput?.(data);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		// Right pane of the split (the preview) only scrolls; everything left of the
		// divider routes into the active list at frame-local coordinates.
		if (event.col >= this.#dividerCol) {
			if (event.wheel !== null) {
				this.#previewScroll = Math.max(0, this.#previewScroll + event.wheel);
				this.#cb.requestRender();
			}
			return true;
		}
		const el = this.#active as Partial<MouseRoutable>;
		if (typeof el.routeMouse === "function") {
			el.routeMouse(event, event.row - this.#bodyRowStart, event.col);
			return true;
		}
		return false;
	}

	// ───────────────────────────── preview ───────────────────────────

	#previewWindow(bodyWidth: number, rows: number): string[] {
		const lines = this.#previewContent(bodyWidth);
		const maxScroll = Math.max(0, lines.length - rows);
		const start = Math.min(this.#previewScroll, maxScroll);
		const window = lines.slice(start, start + rows);
		if (lines.length > rows) {
			const marker =
				start + rows < lines.length
					? theme.fg("dim", `  ↓ ${lines.length - rows - start} more`)
					: theme.fg("dim", "  (end)");
			window[rows - 1] = marker;
		}
		return window;
	}

	#previewContent(bodyWidth: number): string[] {
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		if (value === SAVE_ACTION) {
			return wrap(
				"Persist the ordered selection to `advisor.agents` and rebuild the live advisors without a restart.",
				bodyWidth,
			).map(line => truncateToWidth(theme.fg("muted", line), bodyWidth));
		}
		if (value === CLOSE_ACTION) {
			return wrap("Close the picker. Unsaved changes are discarded.", bodyWidth).map(line =>
				truncateToWidth(theme.fg("muted", line), bodyWidth),
			);
		}
		const agent = this.#agentByName.get(value);
		if (agent) return this.#agentPreview(agent, bodyWidth);
		return wrap("Select an agent to preview it.", bodyWidth).map(line =>
			truncateToWidth(theme.fg("muted", line), bodyWidth),
		);
	}

	#agentPreview(agent: AgentDefinition, bodyWidth: number): string[] {
		const lines = [theme.bold(agent.name), "", `${theme.fg("dim", "Source:")} ${SOURCE_LABEL[agent.source]}`];
		if (agent.description?.trim()) {
			lines.push("", ...wrap(agent.description.trim(), bodyWidth));
		}
		lines.push("");
		if (this.#selected.has(agent.name)) {
			const liveStat = this.#cb.getAdvisorStats?.()?.find(s => s.name === agent.name);
			if (liveStat) {
				lines.push(`${theme.fg("dim", "Advisor:")} ${this.#statusLine(liveStat)}`);
				const spendParts: string[] = [
					`${liveStat.tokens.input.toLocaleString()} in`,
					`${liveStat.tokens.output.toLocaleString()} out`,
				];
				if (liveStat.tokens.cacheRead > 0) {
					spendParts.push(`${liveStat.tokens.cacheRead.toLocaleString()} cache`);
				}
				lines.push(theme.fg("dim", `  Tokens: ${spendParts.join(", ")}`));
				if (liveStat.cost > 0) lines.push(theme.fg("dim", `  Cost: $${liveStat.cost.toFixed(4)}`));
				if (liveStat.contextWindow > 0) {
					const pct = Math.round((liveStat.contextTokens / liveStat.contextWindow) * 100);
					lines.push(
						theme.fg(
							"dim",
							`  Context: ${liveStat.contextTokens.toLocaleString()}/${liveStat.contextWindow.toLocaleString()} (${pct}%)`,
						),
					);
				}
			} else {
				lines.push(theme.fg("muted", "Selected — activates on Save & apply."));
			}
		} else {
			lines.push(theme.fg("muted", "Not selected — Enter toggles this agent as an advisor."));
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	#statusLine(stat: PerAdvisorStat): string {
		const glyph = STATUS_GLYPH[stat.status] ?? "?";
		const label = STATUS_LABEL[stat.status] ?? stat.status;
		const color =
			stat.status === "running"
				? "success"
				: stat.status === "quota_exhausted" || stat.status === "error"
					? "error"
					: "dim";
		return `${theme.fg(color, glyph)} ${theme.fg("dim", label)}`;
	}

	// ───────────────────────────── screens ───────────────────────────

	#setScreen(active: Component, footerHint: string): void {
		this.#active = active;
		this.#footerHint = footerHint;
		this.#previewScroll = 0;
		this.#cb.requestRender();
	}

	#showList(): void {
		const items: SelectItem[] = this.#agents.map(agent => ({
			value: agent.name,
			label: `${this.#selected.has(agent.name) ? "[x]" : "[ ]"} ${agent.name} ${theme.fg(
				"dim",
				`[${SOURCE_LABEL[agent.source]}]`,
			)}`,
			description: previewLine(agent.description),
		}));
		items.push({ value: SAVE_ACTION, label: "Save & apply" });
		items.push({ value: CLOSE_ACTION, label: "Close" });

		// An empty selection falls back to the legacy default advisor on the
		// advisor role — name its model so the fallback isn't a surprise.
		const fallbackHint =
			this.#selected.size === 0 && this.#defaultModelLabel
				? ` · empty → default advisor (${this.#defaultModelLabel})`
				: "";

		// Show every row (no internal overflow-search); the split frame supplies height.
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.setSelectedIndex(this.#cursorIndex);
		list.onSelectionChange = item => {
			this.#cursorIndex = Math.max(
				0,
				items.findIndex(i => i.value === item.value),
			);
			this.#previewScroll = 0;
			this.#cb.requestRender();
		};
		list.onSelect = item =>
			void this.#onListSelect(item.value).catch(err => {
				this.#cb.notify(`Advisor picker: ${err instanceof Error ? err.message : String(err)}`);
			});
		list.onCancel = () => this.#cb.close();
		this.#setScreen(list, `↑↓ move · Enter / click toggle · Save & apply persists · Esc close${fallbackHint}`);
	}

	async #onListSelect(value: string): Promise<void> {
		if (value === SAVE_ACTION) {
			await this.#save();
			return;
		}
		if (value === CLOSE_ACTION) {
			this.#cb.close();
			return;
		}
		if (this.#agentByName.has(value)) this.#toggleAgent(value);
	}

	#toggleAgent(name: string): void {
		if (this.#selected.has(name)) this.#selected.delete(name);
		else this.#selected.add(name);
		this.#dirty = true;
		this.#showList();
	}

	/** Persist the roster-ordered selection (the dashboard `task.disabledAgents` pattern). */
	#persistSelection(): void {
		const names = this.#agents.filter(agent => this.#selected.has(agent.name)).map(agent => agent.name);
		this.#settings.set("advisor.agents", names);
	}

	async #save(): Promise<void> {
		const names = this.#agents.filter(agent => this.#selected.has(agent.name)).map(agent => agent.name);
		this.#persistSelection();
		await this.#cb.save(names);
		this.#dirty = false;
		this.#showList();
	}
}
