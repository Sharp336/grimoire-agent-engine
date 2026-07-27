/**
 * Compact session-model picker (alt+p / `/switch`): a bottom-anchored
 * floating overlay hosting just a {@link ModelBrowser} — no provider sidebar.
 * Model entries switch the current session only; a search beginning with `@`
 * exposes the configured ctrl+p quick roles.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ResolvedRoleModel } from "../../session/agent-session";
import {
	type ConfiguredThinkingLevel,
	getConfiguredThinkingLevelMetadata,
	getConfiguredThinkingLevelsForModel,
} from "../../thinking";
import { theme } from "../theme/theme";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	resolveRoleAssignments,
	sortModelItems,
} from "./model-browser";
import type { ScopedModelItem } from "./model-hub";
import { bottomBorder, row, topBorder } from "./overlay-box";
import { resolveSegmentPalette } from "./segment-track";

export interface ModelPickerCallbacks {
	/** A model and thinking level were chosen for a session-only switch. `selector` is `provider/id`. */
	onPick: (model: Model, selector: string, thinkingLevel: ConfiguredThinkingLevel) => void;
	/** A configured ctrl+p quick role was chosen. */
	onPickRole?: (entry: ResolvedRoleModel) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Session token count; models with smaller context windows are disabled. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
	/** Resolved role models in the same order used by the ctrl+p quick-role cycle. */
	quickRoles?: ReadonlyArray<ResolvedRoleModel>;
	/** Complete ctrl+p order, including unavailable roles, to preserve segment colors. */
	quickRoleOrder?: ReadonlyArray<string>;
	/** Active quick role, highlighted when the search begins with `@`. */
	currentQuickRole?: string;
	/** Resolve the thinking level to preselect for a candidate model. */
	thinkingLevelForModel?: (model: Model) => ConfiguredThinkingLevel | undefined;
}

/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;

const STATUS_HINT = "Step 1 of 2 · Choose a session model — role models stay unchanged";
const QUICK_ROLE_STATUS_HINT = "Quick role switch — applies its model and thinking for this session";
const FOOTER_HINT = "↑/↓ models · Enter choose thinking · type to search · @ quick roles · Esc close";
const QUICK_ROLE_FOOTER_HINT = "↑/↓ roles · Enter apply role model · type to search · Esc close";

/**
 * The alt+p picker component. Hosted as a non-fullscreen bottom-anchored
 * overlay (`ui.showOverlay(..., { anchor: "bottom-center" })`); keyboard-only,
 * since mouse tracking is reserved for fullscreen overlays.
 */
export class ModelPickerComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#browser: ModelBrowser;
	#callbacks: ModelPickerCallbacks;
	#configError: string | undefined;
	#currentSelector: string | undefined;
	#currentQuickRoleSelector: string | undefined;
	#modelItems: ModelBrowserItem[] = [];
	#quickRoleItems: ModelBrowserItem[] = [];
	#quickRoles = new Map<string, ResolvedRoleModel>();
	#roleMode = false;
	#pendingPick:
		| {
				item: ModelBrowserItem;
				levels: ConfiguredThinkingLevel[];
				index: number;
		  }
		| undefined;

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		options: ModelPickerOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#callbacks = callbacks;
		this.#currentSelector = options.currentSelector;
		this.#currentQuickRoleSelector = options.currentQuickRole ? `@${options.currentQuickRole}` : undefined;
		this.#quickRoleItems = this.#buildQuickRoleItems(
			options.quickRoles ?? [],
			options.quickRoleOrder ?? options.quickRoles?.map(entry => entry.role) ?? [],
		);

		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			disableOverContext: true,
			emptyText: () => (this.#roleMode ? "  No quick roles in the Ctrl+P cycle" : undefined),
		});
		this.#browser.onActivate = item => {
			const quickRole = this.#quickRoles.get(item.selector);
			if (quickRole) {
				callbacks.onPickRole?.(quickRole);
				return;
			}
			const levels = getConfiguredThinkingLevelsForModel(item.model);
			const current = options.thinkingLevelForModel?.(item.model) ?? ThinkingLevel.Inherit;
			const currentIndex = levels.indexOf(current);
			if (getSupportedEfforts(item.model).length === 0) {
				callbacks.onPick(item.model, item.selector, currentIndex >= 0 ? current : ThinkingLevel.Inherit);
				return;
			}
			this.#pendingPick = { item, levels, index: currentIndex >= 0 ? currentIndex : 0 };
			this.#tui.requestRender();
		};
		this.#browser.onCancel = () => callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#syncItemsForQuery(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	invalidate(): void {}

	/** Rebuild model items and role chips from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			try {
				models = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				models = [];
			}
		}

		const allModels = this.#scopedModels.length > 0 ? models : this.#registry.getAll();
		const roles = resolveRoleAssignments(this.#settings, allModels, models);
		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		this.#modelItems = buildBrowserItems(models);
		sortModelItems(this.#modelItems, { roles, mruOrder });
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());
		this.#syncItemsForQuery(this.#browser.query, true);
	}

	/** Build virtual `@role` rows, colored by their ctrl+p segment position. */
	#buildQuickRoleItems(
		quickRoles: ReadonlyArray<ResolvedRoleModel>,
		quickRoleOrder: ReadonlyArray<string>,
	): ModelBrowserItem[] {
		const order = quickRoleOrder.length > 0 ? quickRoleOrder : quickRoles.map(entry => entry.role);
		const palette = resolveSegmentPalette(order.length);
		return quickRoles.map((entry, index) => {
			const selector = `@${entry.role}`;
			this.#quickRoles.set(selector, entry);
			const orderIndex = order.indexOf(entry.role);
			return {
				provider: "",
				id: selector,
				model: entry.model,
				selector,
				labelColor: palette[(orderIndex >= 0 ? orderIndex : index) % palette.length],
			};
		});
	}

	/** Switch browser content only when a leading `@` changes the search mode. */
	#syncItemsForQuery(query: string, refresh = false): void {
		const roleMode = query.startsWith("@");
		const modeChanged = roleMode !== this.#roleMode;
		if (!modeChanged && !refresh) return;

		this.#roleMode = roleMode;
		this.#browser.setShowProvider(!roleMode);
		this.#browser.setDisableOverContext(!roleMode);
		this.#browser.setPreserveQueryOrder(roleMode);
		const currentSelector = roleMode ? this.#currentQuickRoleSelector : this.#currentSelector;
		this.#browser.setCurrentSelector(currentSelector);
		this.#browser.setItems(roleMode ? this.#quickRoleItems : this.#modelItems);
		if (modeChanged && currentSelector) {
			this.#browser.selectSelector(currentSelector);
		}
	}

	handleInput(data: string): void {
		// Mouse tracking is off outside fullscreen overlays; drop any stray SGR
		// reports instead of feeding them to the search input.
		if (data.startsWith("\x1b[<")) return;
		const pending = this.#pendingPick;
		if (!pending) {
			this.#browser.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#pendingPick = undefined;
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			pending.index = (pending.index - 1 + pending.levels.length) % pending.levels.length;
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
			pending.index = (pending.index + 1) % pending.levels.length;
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const level = pending.levels[pending.index];
			if (level !== undefined) this.#callbacks.onPick(pending.item.model, pending.item.selector, level);
		}
	}

	#renderThinkingFooter(width: number): string {
		const pending = this.#pendingPick;
		if (!pending) return "";
		const labels = pending.levels.map(level => getConfiguredThinkingLevelMetadata(level).label);
		const selectedLabel = labels[pending.index] ?? "";
		const selectedChoiceWidth = visibleWidth(` [ ${selectedLabel} ] `);
		const maxPrefixWidth = Math.max(0, width - selectedChoiceWidth - 3);
		const prefix = truncateToWidth(`${theme.fg("accent", pending.item.id)}${theme.fg("dim", " →")} `, maxPrefixWidth);
		const prefixWidth = visibleWidth(prefix);
		const available = Math.max(1, width - prefixWidth);
		const choiceWidths = labels.map(
			(label, index) => visibleWidth(` ${label} `) + (index === pending.index ? 2 : 0) + 1,
		);
		let start = 0;
		while (start < pending.index) {
			let used = start > 0 ? 2 : 0;
			for (let index = start; index <= pending.index; index++) used += choiceWidths[index] ?? 0;
			if (used <= available) break;
			start++;
		}
		let line = prefix;
		if (start > 0) line += theme.fg("dim", "… ");
		for (let index = start; index < labels.length; index++) {
			const label = labels[index];
			if (!label) continue;
			const body = ` ${label} `;
			line +=
				index === pending.index
					? theme.bg("selectedBg", `${theme.fg("accent", "[")}${body}${theme.fg("accent", "]")}`)
					: body;
			line += " ";
		}
		return truncateToWidth(line, width);
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.floor(termRows * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS;
		this.#browser.setMaxVisible(Math.max(MIN_VISIBLE, listBudget));
		this.#browser.setFocused(this.#pendingPick === undefined);

		const inner = Math.max(1, width - 4);
		const pending = this.#pendingPick;
		const status = this.#configError
			? theme.fg("error", ` ${this.#configError}`)
			: pending
				? theme.fg("muted", ` 2/2 · ↑/↓ · Enter apply · Esc back · ${pending.item.id}`)
				: theme.fg("muted", ` ${this.#roleMode ? QUICK_ROLE_STATUS_HINT : STATUS_HINT}`);

		const out: string[] = [];
		out.push(topBorder(width, "Switch Model"));
		out.push(row(status, width));
		for (const line of this.#browser.render(inner)) {
			out.push(row(line, width));
		}
		out.push(
			row(
				pending
					? this.#renderThinkingFooter(inner)
					: theme.fg("dim", this.#roleMode ? QUICK_ROLE_FOOTER_HINT : FOOTER_HINT),
				width,
			),
		);
		out.push(bottomBorder(width));
		return out;
	}
}
