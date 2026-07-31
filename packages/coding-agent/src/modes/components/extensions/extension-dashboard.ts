/**
 * ExtensionDashboard - Fullscreen alternate-screen control center for extensions.
 *
 * Chrome mirrors the `/settings` overlay: a titled rounded box, a shared
 * {@link TabBar} for provider selection, and a two-column body (inventory list |
 * inspector). Both panes are mouse-aware — wheel scrolls, hover highlights, and
 * clicks select/activate — routed from a single SGR-mouse handler.
 *
 * Navigation:
 * - Tab/Shift+Tab or ←/→: switch provider tab
 * - Up/Down/j/k or wheel: move list selection
 * - Space/Enter or click: toggle selected item (or provider master switch)
 * - Wheel over the inspector: scroll the detail pane
 * - Esc: clear search (if active) then close
 */
import {
	type Component,
	matchesKey,
	padding,
	parseSgrMouse,
	ScrollView,
	type Tab,
	TabBar,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import {
	type ActivationScope,
	type ActivationWriteTarget,
	type ProjectActivation,
	projectActivationKindFromExtensionId,
	Settings,
} from "../../../config/settings";
import { syncDisabledProviders as syncCapabilityDisabledProviders } from "../../../discovery";
import { getTabBarTheme } from "../../../modes/shared";
import { theme } from "../../../modes/theme/theme";
import { matchesAppInterrupt } from "../../../modes/utils/keybinding-matchers";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";
import { ExtensionList } from "./extension-list";
import { InspectorPanel } from "./inspector-panel";
import {
	applyDisabledExtensionsToState,
	applyFilter,
	buildProviderTabs,
	createInitialState,
	extensionRowKey,
	filterByProvider,
	refreshState,
} from "./state-manager";
import type { ActivationMode, DashboardState, ProviderTab } from "./types";

const EXT_FOOTER = "↑/↓: navigate · Space: toggle · ←/→: provider · Esc: close";
const EXT_SCOPE_FOOTER = "↑/↓: navigate · Space: toggle · Ctrl+P: scope · ←/→: provider · Esc: close";
const WRITE_SCOPE_ICON = "✎";

export function extensionDashboardTitle(scope: ActivationScope): string {
	return `Extension Control Center · ${WRITE_SCOPE_ICON} ${scope === "project" ? "Project" : "Global"}`;
}

export function extensionDashboardFooter(canUseProjectScope: boolean): string {
	return ` ${canUseProjectScope ? EXT_SCOPE_FOOTER : EXT_FOOTER}`;
}

interface ActivationCycleInput {
	current: ProjectActivation;
	currentlyDisabled: boolean;
	target: ActivationWriteTarget;
	mode?: ActivationMode;
	rowDisabled?: boolean;
}

export function nextExtensionActivationState(input: ActivationCycleInput): ProjectActivation {
	if (input.target === "global") return input.current === "disabled" ? "enabled" : "disabled";
	if (input.mode === "binary") return input.rowDisabled ? "enabled" : "disabled";
	if (input.current === "inherit") return input.currentlyDisabled ? "enabled" : "disabled";
	if (input.current === "disabled") return "enabled";
	return "inherit";
}

function normalizeBinaryActivationState(
	current: ProjectActivation,
	mode: ActivationMode,
	fallback: ProjectActivation,
): ProjectActivation {
	if (mode !== "binary" || current !== "inherit") return current;
	return fallback;
}

export function buildTabBarTabs(tabs: ProviderTab[]): Tab[] {
	return tabs.map(tab => {
		const isAll = tab.id === "all";
		const isEmptyEnabled = tab.count === 0 && tab.enabled && !isAll;
		const isDisabled = !tab.enabled && !isAll;
		let label = tab.label;
		if (tab.count > 0) label += ` (${tab.count})`;
		if (isDisabled) label = `${theme.status.disabled} ${label}`;
		return { id: tab.id, label, short: tab.label, muted: isEmptyEnabled };
	});
}

export class ExtensionDashboard implements Component {
	#state!: DashboardState;
	#mainList!: ExtensionList;
	#inspector!: InspectorPanel;
	#tabBar!: TabBar;
	#body!: TwoColumnBody;
	#activationScope: ActivationScope = "global";
	#canUseProjectScope = false;
	#refreshToken = 0;
	// Frame geometry from the last render, for SGR mouse hit-testing. The
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1.
	#tabRowStart = 0;
	#tabRowCount = 0;
	#bodyRowStart = 0;
	#bodyRowCount = 0;

	onClose?: () => void;
	onRequestRender?: () => void;

	private constructor(
		private readonly cwd: string,
		private readonly settings: Settings | null,
		private readonly terminalHeight: number,
	) {}

	static async create(
		cwd: string,
		settings: Settings | null = null,
		terminalHeight?: number,
	): Promise<ExtensionDashboard> {
		const dashboard = new ExtensionDashboard(cwd, settings, terminalHeight ?? process.stdout.rows ?? 24);
		await dashboard.#init();
		return dashboard;
	}

	async #init(): Promise<void> {
		const sm = this.settings ?? (await Settings.init());
		this.#canUseProjectScope = sm.canUseProjectActivation(this.cwd);
		this.#activationScope = sm.getDefaultActivationScope(this.cwd);
		const disabledIds = sm.getActivationDisabledExtensions(this.#activationScope);
		this.#state = this.#withActivationMetadata(await createInitialState(this.cwd, disabledIds));

		const initialMaxVisible = Math.max(3, this.terminalHeight - 9);
		this.#mainList = new ExtensionList(
			this.#state.searchFiltered,
			{
				onSelectionChange: ext => {
					this.#state.selected = ext;
					this.#inspector.setExtension(ext);
					// A fresh selection resets the inspector to the top.
					this.#body.resetInspectorScroll();
				},
				onToggle: (extensionId, enabled) => this.#handleExtensionToggle(extensionId, enabled),
				onActivationCycle: extension => this.#handleActivationCycle(extension),
				onMasterToggle: providerId => this.#handleProviderToggle(providerId),
				masterSwitchProvider: this.#getActiveProviderId(),
				masterSwitchActivationState: this.#getActiveProviderActivationState(),
				masterSwitchEnabled: this.#getActiveProviderEnabled(),
			},
			initialMaxVisible,
		);
		this.#mainList.setFocused(true);

		this.#inspector = new InspectorPanel();
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#body = new TwoColumnBody(this.#mainList, this.#inspector, this.terminalHeight);

		this.#tabBar = new TabBar("", buildTabBarTabs(this.#state.tabs), getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = tab => this.#selectProviderById(tab.id);
		const activeId = this.#state.tabs[this.#state.activeTabIndex]?.id;
		if (activeId) this.#tabBar.setActiveById(activeId);
	}

	#getActiveProviderId(): string | null {
		const tab = this.#state.tabs[this.#state.activeTabIndex];
		return tab && tab.id !== "all" ? tab.id : null;
	}

	#getActiveProviderActivationState(): ProjectActivation | null {
		const providerId = this.#getActiveProviderId();
		if (!providerId) return null;
		const sm = this.settings ?? Settings.instance;
		const current = sm.getProviderActivation(providerId, this.#activationScope);
		const mode = this.#getProviderActivationMode(providerId);
		const fallback = sm.isProviderEffectivelyDisabled(providerId, this.#activationScope) ? "disabled" : "enabled";
		return normalizeBinaryActivationState(current, mode, fallback);
	}

	#getProviderActivationMode(providerId: string): ActivationMode {
		if (this.#activationScope !== "project") return "tri-state";
		const hasNonProjectRows = this.#state.extensions.some(
			ext => ext.source.provider === providerId && ext.source.level !== "project",
		);
		return hasNonProjectRows ? "tri-state" : "binary";
	}

	#getActiveProviderEnabled(): boolean | null {
		const providerId = this.#getActiveProviderId();
		if (!providerId) return null;
		const sm = this.settings ?? Settings.instance;
		return !sm.isProviderEffectivelyDisabled(providerId, this.#activationScope);
	}

	#withActivationMetadata(state: DashboardState): DashboardState {
		const sm = this.settings ?? Settings.instance;
		const target = sm.getActivationWriteTarget(this.cwd, this.#activationScope);
		const scopedState = target === "global" ? this.#withoutProjectRows(state) : state;
		// Capability discovery marks lower-priority rows as shadowed before the
		// dashboard applies project activation overrides. If the project row that
		// caused the shadow is disabled, reveal the user/global peer while preserving
		// its original disable signals (provider off, global disabled, MCP enabled:false).
		const nonProjectIds = new Set(
			scopedState.extensions.filter(ext => ext.source.level !== "project").map(ext => ext.id),
		);
		const disabledProjectShadowIds = new Set(
			scopedState.extensions
				.filter(ext => {
					if (ext.source.level !== "project" || !nonProjectIds.has(ext.id)) return false;
					const parsed = projectActivationKindFromExtensionId(ext.id);
					return !!parsed && sm.getProjectActivation(parsed.kind, parsed.name, "project") === "disabled";
				})
				.map(ext => ext.id),
		);
		const annotate = (ext: DashboardState["extensions"][number]): DashboardState["extensions"][number] => {
			const revealNonProjectPeer =
				ext.source.level !== "project" &&
				disabledProjectShadowIds.has(ext.id) &&
				ext.disabledReason !== "provider-disabled";
			const revealParsed = revealNonProjectPeer ? projectActivationKindFromExtensionId(ext.id) : null;
			const rawMcpEnabled = (ext.raw as { enabled?: unknown }).enabled;
			const sourceMcpDisabled = revealParsed?.kind === "mcp" && rawMcpEnabled === false;
			const revealAsProviderDisabled =
				revealNonProjectPeer && sm.isProviderEffectivelyDisabled(ext.source.provider, "project");
			const revealAsItemDisabled = revealParsed
				? sm.isGlobalActivationDisabled(revealParsed.kind, revealParsed.name) ||
					(sourceMcpDisabled && !sm.isGlobalActivationEnabled(revealParsed.kind, revealParsed.name))
				: false;
			const effectiveExt = revealNonProjectPeer
				? {
						...ext,
						state: revealAsProviderDisabled || revealAsItemDisabled ? ("disabled" as const) : ("active" as const),
						disabledReason: revealAsProviderDisabled
							? ("provider-disabled" as const)
							: revealAsItemDisabled
								? ("item-disabled" as const)
								: undefined,
						shadowedBy: undefined,
					}
				: ext;
			const parsed = projectActivationKindFromExtensionId(effectiveExt.id);
			if (!parsed || effectiveExt.state === "shadowed") {
				return {
					...effectiveExt,
					activationState: undefined,
					activationTarget: undefined,
					activationMode: undefined,
				};
			}
			const hasNonProjectPeer = nonProjectIds.has(effectiveExt.id);
			const projectOnly = target === "project" && effectiveExt.source.level === "project" && !hasNonProjectPeer;
			const storedState = sm.getProjectActivation(parsed.kind, parsed.name, this.#activationScope);
			const activationMode: ActivationMode = projectOnly || target === "global" ? "binary" : "tri-state";
			return {
				...effectiveExt,
				activationState: normalizeBinaryActivationState(storedState, activationMode, "enabled"),
				activationTarget: target,
				activationMode,
			};
		};
		const selectedKey = scopedState.selected ? extensionRowKey(scopedState.selected) : null;
		const extensions = scopedState.extensions.map(annotate);
		const tabFiltered = scopedState.tabFiltered.map(annotate);
		const searchFiltered = scopedState.searchFiltered.map(annotate);
		return {
			...scopedState,
			extensions,
			tabFiltered,
			searchFiltered,
			selected: selectedKey ? (searchFiltered.find(ext => extensionRowKey(ext) === selectedKey) ?? null) : null,
		};
	}

	#withoutProjectRows(state: DashboardState): DashboardState {
		const sm = this.settings ?? Settings.instance;
		const projectIds = new Set(state.extensions.filter(ext => ext.source.level === "project").map(ext => ext.id));
		const normalizeGlobalRow = (ext: DashboardState["extensions"][number]): DashboardState["extensions"][number] => {
			const parsed = projectActivationKindFromExtensionId(ext.id);
			if (parsed && sm.isProjectActivationEffectivelyDisabled(parsed.kind, parsed.name, "global")) {
				return { ...ext, state: "disabled", disabledReason: "item-disabled", shadowedBy: undefined };
			}
			if (sm.isProviderEffectivelyDisabled(ext.source.provider, "global")) {
				return { ...ext, state: "disabled", disabledReason: "provider-disabled", shadowedBy: undefined };
			}
			if (ext.state !== "disabled" && !(projectIds.has(ext.id) && ext.state === "shadowed")) return ext;

			const active = { ...ext, state: "active" as const };
			if (projectIds.has(ext.id)) active.shadowedBy = undefined;
			delete active.disabledReason;
			return active;
		};

		const extensions = state.extensions.filter(ext => ext.source.level !== "project").map(normalizeGlobalRow);
		const tabs = buildProviderTabs(extensions).map(tab =>
			tab.id === "all" ? tab : { ...tab, enabled: !sm.isProviderEffectivelyDisabled(tab.id, "global") },
		);
		const currentTabId = state.tabs[state.activeTabIndex]?.id ?? "all";
		const activeTabIndex = Math.max(
			0,
			tabs.findIndex(tab => tab.id === currentTabId),
		);
		const activeTabId = tabs[activeTabIndex]?.id ?? "all";
		const tabFiltered = filterByProvider(extensions, activeTabId);
		const searchFiltered = applyFilter(tabFiltered, state.searchQuery);
		const selectedKey = state.selected ? extensionRowKey(state.selected) : null;
		const selected = selectedKey ? (searchFiltered.find(ext => extensionRowKey(ext) === selectedKey) ?? null) : null;

		return {
			...state,
			tabs,
			activeTabIndex,
			extensions,
			tabFiltered,
			searchFiltered,
			selected: selected ?? searchFiltered[0] ?? null,
		};
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.terminalHeight || 24;
	}

	/**
	 * Fullscreen frame: titled top border, the tab row(s), a divider, the
	 * two-column body sized to fill the viewport, a divider, the footer hint, and
	 * the bottom border. Records row geometry for mouse hit-testing.
	 */
	render(width: number): readonly string[] {
		const height = Math.max(14, this.#terminalRows());
		const innerWidth = Math.max(1, width - 4);

		const tabLines = this.#tabBar.render(innerWidth);
		// Fixed chrome: top border + tab rows + divider + divider + footer + bottom border.
		const fixedRows = 1 + tabLines.length + 1 + 1 + 1 + 1;
		const contentRows = Math.max(5, height - fixedRows);

		this.#mainList.setMaxVisible(Math.max(3, contentRows - 2));
		this.#body.setMaxHeight(contentRows);
		const bodyLines = this.#body.render(innerWidth);

		const out: string[] = [];
		out.push(topBorder(width, extensionDashboardTitle(this.#activationScope)));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) out.push(row(line, width));
		out.push(divider(width));
		this.#bodyRowStart = out.length;
		this.#bodyRowCount = contentRows;
		for (let i = 0; i < contentRows; i++) out.push(row(bodyLines[i] ?? "", width));
		out.push(divider(width));
		out.push(row(theme.fg("dim", extensionDashboardFooter(this.#canUseProjectScope)), width));
		out.push(bottomBorder(width));
		return out;
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#mainList.invalidate();
		this.#inspector.invalidate();
	}

	/**
	 * Route an SGR mouse report against the last render's geometry. Wheel scrolls
	 * the pane under the pointer, motion drives hover highlights (tabs + rows),
	 * and a left click switches tabs or selects/activates a list row.
	 */
	#handleMouse(data: string): void {
		const event = parseSgrMouse(data);
		if (!event) return;

		// row() insets content by two columns (border + space).
		const innerCol = event.col - 2;
		const tabLine = event.row - this.#tabRowStart;
		const overTabs = tabLine >= 0 && tabLine < this.#tabRowCount;
		const bodyLine = event.row - this.#bodyRowStart;
		const overBody = bodyLine >= 0 && bodyLine < this.#bodyRowCount;
		const leftWidth = this.#body.leftWidth;
		const overList = overBody && innerCol < leftWidth;
		const overInspector = overBody && innerCol >= leftWidth + 3;

		if (event.wheel !== null) {
			if (overList) {
				this.#mainList.handleWheel(event.wheel);
				this.onRequestRender?.();
			} else if (overInspector) {
				this.#body.scrollInspector(event.wheel);
				this.onRequestRender?.();
			}
			return;
		}

		if (event.motion) {
			const hoveredTab = overTabs ? this.#tabBar.tabAt(tabLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hoveredTab && !hoveredTab.muted ? hoveredTab.id : null);
			this.#mainList.setHoverIndex(overList ? this.#mainList.hitTest(bodyLine) : null);
			this.onRequestRender?.();
			return;
		}

		if (!event.leftClick) return;

		if (overTabs) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) this.#tabBar.selectTab(tab.id);
			return;
		}
		if (overList) {
			this.#mainList.handleClick(bodyLine);
			this.onRequestRender?.();
		}
	}

	/** Switch to the provider tab with `id`, re-filtering the list around it. */
	#selectProviderById(id: string): void {
		const index = this.#state.tabs.findIndex(t => t.id === id);
		if (index < 0) return;
		this.#state.activeTabIndex = index;

		const tab = this.#state.tabs[index];
		this.#state.tabFiltered = filterByProvider(this.#state.extensions, tab.id);
		this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, this.#state.searchQuery);
		this.#state.listIndex = 0;
		this.#state.scrollOffset = 0;
		this.#state.selected = this.#state.searchFiltered[0] ?? null;

		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(
			this.#getActiveProviderId(),
			this.#getActiveProviderActivationState(),
			this.#getActiveProviderEnabled(),
		);
		this.#mainList.resetSelection();
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}
		this.#body.resetInspectorScroll();
		this.onRequestRender?.();
	}

	#handleProviderToggle(providerId: string): void {
		const sm = this.settings ?? Settings.instance;
		const current = sm.getProviderActivation(providerId, this.#activationScope);
		const target = sm.getActivationWriteTarget(this.cwd, this.#activationScope);
		const currentlyDisabled = sm.isProviderEffectivelyDisabled(providerId, this.#activationScope);
		const next = nextExtensionActivationState({
			current,
			currentlyDisabled,
			target,
			mode: this.#getProviderActivationMode(providerId),
			rowDisabled: currentlyDisabled,
		});
		void sm.setProviderActivation(providerId, next, this.#activationScope).then(() => {
			syncCapabilityDisabledProviders((sm.get("disabledProviders") as string[]) ?? []);
			void this.#refreshFromState();
		});
	}

	#handleExtensionToggle(extensionId: string, enabled: boolean): void {
		const sm = this.settings ?? Settings.instance;
		const disabled = ((sm.get("disabledExtensions") as string[]) ?? []).slice();
		if (enabled) {
			const index = disabled.indexOf(extensionId);
			if (index !== -1) {
				disabled.splice(index, 1);
				sm.set("disabledExtensions", disabled);
			}
		} else if (!disabled.includes(extensionId)) {
			disabled.push(extensionId);
			sm.set("disabledExtensions", disabled);
		}

		this.#applyDisabledExtensions(disabled);
		void this.#refreshFromState();
	}

	#handleActivationCycle(extension: DashboardState["extensions"][number]): void {
		const sm = this.settings ?? Settings.instance;
		if (!extension.activationState || extension.state === "shadowed") return;
		const parsed = projectActivationKindFromExtensionId(extension.id);
		if (!parsed) return;

		const current = sm.getProjectActivation(parsed.kind, parsed.name, this.#activationScope);
		const target = sm.getActivationWriteTarget(this.cwd, this.#activationScope);
		const currentlyDisabled = sm.isProjectActivationEffectivelyDisabled(
			parsed.kind,
			parsed.name,
			this.#activationScope,
		);
		const next = nextExtensionActivationState({
			current,
			currentlyDisabled,
			target,
			mode: extension.activationMode,
			rowDisabled: extension.state === "disabled",
		});
		void sm.setProjectActivation(parsed.kind, parsed.name, next, this.#activationScope).then(() => {
			this.#applyDisabledExtensions(sm.getActivationDisabledExtensions(this.#activationScope));
			void this.#refreshFromState();
		});
	}

	async #refreshFromState(): Promise<void> {
		const refreshToken = ++this.#refreshToken;
		// Remember the current tab so it survives the re-sort.
		const currentTabId = this.#state.tabs[this.#state.activeTabIndex]?.id;

		const sm = this.settings ?? Settings.instance;
		const disabledIds = sm.getActivationDisabledExtensions(this.#activationScope);
		const nextState = await refreshState(this.#state, this.cwd, disabledIds);
		if (refreshToken !== this.#refreshToken) return;
		this.#state = this.#withActivationMetadata(nextState);

		// Re-anchor on the same tab id in the (re-sorted) list.
		if (currentTabId) {
			const newIndex = this.#state.tabs.findIndex(t => t.id === currentTabId);
			if (newIndex >= 0) {
				this.#state.activeTabIndex = newIndex;
			}
		}

		this.#syncListSelection();

		this.#tabBar.setTabs(buildTabBarTabs(this.#state.tabs), currentTabId);
		this.onRequestRender?.();
	}

	#applyDisabledExtensions(disabledIds: string[]): void {
		this.#state = this.#withActivationMetadata(applyDisabledExtensionsToState(this.#state, disabledIds));
		this.#syncListSelection();
		this.#tabBar.setTabs(buildTabBarTabs(this.#state.tabs), this.#state.tabs[this.#state.activeTabIndex]?.id);
		this.onRequestRender?.();
	}

	#syncListSelection(): void {
		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(
			this.#getActiveProviderId(),
			this.#getActiveProviderActivationState(),
			this.#getActiveProviderEnabled(),
		);
		this.#mainList.selectExtensionByKey(this.#state.selected ? extensionRowKey(this.#state.selected) : null);
		this.#inspector.setExtension(this.#state.selected ?? null);
	}

	#toggleActivationScope(): void {
		if (!this.#canUseProjectScope) return;
		const sm = this.settings ?? Settings.instance;
		this.#activationScope = this.#activationScope === "project" ? "global" : "project";
		this.#applyDisabledExtensions(sm.getActivationDisabledExtensions(this.#activationScope));
		void this.#refreshFromState();
	}

	handleInput(data: string): void {
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		// Ctrl+C - close immediately
		if (matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}

		if (matchesKey(data, "ctrl+p")) {
			this.#toggleActivationScope();
			return;
		}

		// Escape - clear search first, then close
		if (matchesAppInterrupt(data)) {
			if (this.#state.searchQuery.length > 0) {
				this.#state.searchQuery = "";
				this.#state.searchFiltered = this.#state.tabFiltered;
				this.#mainList.setExtensions(this.#state.searchFiltered);
				this.#mainList.clearSearch();
				this.onRequestRender?.();
				return;
			}
			this.onClose?.();
			return;
		}

		// Tab/Shift+Tab or ←/→: switch provider tabs (fires onTabChange).
		if (this.#tabBar.handleInput(data)) {
			return;
		}

		// All other input goes to the list.
		this.#mainList.handleInput(data);

		// Sync search query back to state.
		const query = this.#mainList.getSearchQuery();
		if (query !== this.#state.searchQuery) {
			this.#state.searchQuery = query;
			this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, query);
		}
		this.onRequestRender?.();
	}
}

/**
 * Two-column body: inventory list on the left, inspector on the right, split by
 * a vertical rule. The inspector is a {@link ScrollView} viewport so long detail
 * panes scroll (wheel) with an auto scrollbar; the left list manages its own
 * windowing. Records the left-column width so the host can hit-test panes.
 */
class TwoColumnBody implements Component {
	#maxHeight: number;
	#rightScroll = 0;
	#rightTotal = 0;
	#leftWidth = 0;

	constructor(
		private readonly leftPane: ExtensionList,
		private readonly rightPane: InspectorPanel,
		maxHeight: number,
	) {
		this.#maxHeight = maxHeight;
	}

	setMaxHeight(maxHeight: number): void {
		this.#maxHeight = maxHeight;
	}

	/** Content width of the left (list) column from the last render. */
	get leftWidth(): number {
		return this.#leftWidth;
	}

	resetInspectorScroll(): void {
		this.#rightScroll = 0;
	}

	/** Wheel notch over the inspector pane: scroll its content, clamped. */
	scrollInspector(delta: -1 | 1): void {
		const max = Math.max(0, this.#rightTotal - this.#maxHeight);
		this.#rightScroll = Math.max(0, Math.min(this.#rightScroll + delta, max));
	}

	render(width: number): readonly string[] {
		const leftWidth = Math.floor(width * 0.5);
		this.#leftWidth = leftWidth;
		const rightWidth = Math.max(0, width - leftWidth - 3);
		const numLines = this.#maxHeight;

		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);
		this.#rightTotal = rightLines.length;
		const maxScroll = Math.max(0, this.#rightTotal - numLines);
		if (this.#rightScroll > maxScroll) this.#rightScroll = maxScroll;

		// `totalRows` omitted so the ScrollView windows `rightLines` by the scroll
		// offset (rather than treating them as a pre-windowed slice) and pads short
		// content to exactly `numLines`.
		const rightView = new ScrollView(rightLines, {
			height: numLines,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		rightView.setScrollOffset(this.#rightScroll);
		const rightRendered = rightView.render(rightWidth);

		const combined: string[] = [];
		const separator = theme.fg("dim", ` ${theme.boxRound.vertical} `);
		for (let i = 0; i < numLines; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = rightRendered[i] ?? "";
			combined.push(leftPadded + separator + right);
		}

		return combined;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}
