/**
 * Plugin settings UI components.
 *
 * Provides a hierarchical settings interface:
 * - Plugin list (shows all installed plugins — npm + marketplace)
 *   - npm plugin detail (enable/disable, features, config)
 *     - Feature toggles
 *     - Config value editor
 *   - Marketplace plugin detail (enable/disable + read-only metadata)
 */
import {
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@oh-my-pi/pi-tui";
import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import { PluginManager } from "../../extensibility/plugins/manager";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import type { InstalledPluginSummary } from "../../extensibility/plugins/marketplace/types";
import type { InstalledPlugin, PluginSettingSchema } from "../../extensibility/plugins/types";
import { getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";

/**
 * Forwards a keystroke to `input`, but cancels via `onCancel` when the user presses Escape.
 */
export function handleInputOrEscape(
	data: string,
	input: { handleInput(data: string): void },
	onCancel: () => void,
): void {
	if (data === "\x1b" || data === "\x1b\x1b") {
		onCancel();
		return;
	}
	input.handleInput(data);
}

// =============================================================================
// Plugin List Component
// =============================================================================

/** A single entry in the plugin list — either an npm plugin or a marketplace plugin. */
export type PluginListEntry =
	| { kind: "npm"; plugin: InstalledPlugin }
	| { kind: "marketplace"; plugin: InstalledPluginSummary };

export interface PluginListCallbacks {
	onPluginSelect: (entry: PluginListEntry) => void;
	onCancel: () => void;
}

const MARKETPLACE_BADGE = "[mkt]";

/** Stable key for an entry — used to recover the entry from a `SelectItem.value`. */
function entryKey(entry: PluginListEntry): string {
	return entry.kind === "npm" ? `npm:${entry.plugin.name}` : `mkt:${entry.plugin.id}:${entry.plugin.scope}`;
}

/**
 * Shows list of installed plugins with enable/disable status. Selecting a plugin
 * opens its detail view. Marketplace plugins are tagged with a `[mkt]` badge.
 */
export class PluginListComponent extends Container {
	readonly #selectList: SelectList;

	constructor(
		private readonly entries: PluginListEntry[],
		callbacks: PluginListCallbacks,
	) {
		super();

		// Title
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "  Plugins")), 0, 0));
		this.addChild(new Spacer(1));

		if (entries.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No plugins installed"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Install npm plugin:        omp plugin install <package>"), 0, 0));
			this.addChild(
				new Text(theme.fg("dim", "  Install marketplace plugin: omp plugin install <name>@<marketplace>"), 0, 0),
			);
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder());

			// Create empty list that just handles escape
			this.#selectList = new SelectList([], 1, getSelectListTheme());
			this.#selectList.onCancel = callbacks.onCancel;
			return;
		}

		const items: SelectItem[] = entries.map(entry => {
			if (entry.kind === "npm") {
				const p = entry.plugin;
				const status = p.enabled
					? theme.fg("success", theme.status.enabled)
					: theme.fg("muted", theme.status.disabled);
				const featureCount = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
				const enabledCount = p.enabledFeatures?.length ?? featureCount;

				let details = `v${p.version}`;
				if (featureCount > 0) {
					details += ` ${theme.sep.dot} ${enabledCount}/${featureCount} features`;
				}

				return {
					value: entryKey(entry),
					label: `${status} ${p.name}`,
					description: details,
				};
			}

			// Marketplace entry — represented by its first registry entry (the canonical install).
			const m = entry.plugin;
			const first = m.entries[0];
			const isEnabled = first?.enabled !== false;
			const status = isEnabled
				? theme.fg("success", theme.status.enabled)
				: theme.fg("muted", theme.status.disabled);
			const badge = theme.fg("muted", MARKETPLACE_BADGE);
			const scope = theme.fg("dim", `[${m.scope}]`);
			const shadowed = m.shadowedBy ? ` ${theme.fg("muted", "(shadowed by project)")}` : "";

			return {
				value: entryKey(entry),
				label: `${status} ${badge} ${m.id} ${scope}${shadowed}`,
				description: first ? `v${first.version}` : "",
			};
		});

		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());

		this.#selectList.onSelect = item => {
			const entry = this.entries.find(e => entryKey(e) === item.value);
			if (entry) {
				callbacks.onPluginSelect(entry);
			}
		};

		this.#selectList.onCancel = callbacks.onCancel;

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to configure · Esc to go back"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

// =============================================================================
// Plugin Detail Component
// =============================================================================

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange: (feature: string, enabled: boolean) => void;
	onConfigChange: (key: string, value: unknown) => void;
	onBack: () => void;
}

/**
 * Shows detail settings for a single plugin:
 * - Enable/disable toggle
 * - Feature toggles
 * - Config settings
 */
export class PluginDetailComponent extends Container {
	#settingsList!: SettingsList;

	constructor(
		private plugin: InstalledPlugin,
		private readonly manager: PluginManager,
		private readonly callbacks: PluginDetailCallbacks,
	) {
		super();

		void this.#rebuild();
	}

	async #rebuild(): Promise<void> {
		this.clear();

		const plugin = this.plugin;
		const manifest = plugin.manifest;

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${plugin.name}`)), 0, 0));
		if (manifest.description) {
			this.addChild(new Text(theme.fg("muted", `  ${manifest.description}`), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [];

		// Enable/disable toggle
		items.push({
			id: "__enabled__",
			label: "Enabled",
			description: "Enable or disable this plugin",
			currentValue: plugin.enabled ? "true" : "false",
			values: ["true", "false"],
		});

		// Feature toggles
		if (manifest.features && Object.keys(manifest.features).length > 0) {
			const enabledSet = new Set(plugin.enabledFeatures ?? []);
			const defaultFeatures = Object.entries(manifest.features)
				.filter(([_, f]) => f.default)
				.map(([name]) => name);

			// If enabledFeatures is null, use defaults
			const effectiveEnabled = plugin.enabledFeatures === null ? new Set(defaultFeatures) : enabledSet;

			for (const [featName, feat] of Object.entries(manifest.features)) {
				const isEnabled = effectiveEnabled.has(featName);
				items.push({
					id: `feature:${featName}`,
					label: `  ${featName}`,
					description: feat.description || `Enable ${featName} feature`,
					currentValue: isEnabled ? "true" : "false",
					values: ["true", "false"],
				});
			}
		}

		// Config settings
		if (manifest.settings && Object.keys(manifest.settings).length > 0) {
			const settings = await this.manager.getPluginSettings(plugin.name);

			for (const [key, schema] of Object.entries(manifest.settings)) {
				const currentValue = settings[key] ?? schema.default;
				const displayValue = schema.secret && currentValue ? "••••••••" : String(currentValue ?? "(not set)");

				if (schema.type === "boolean") {
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: currentValue ? "true" : "false",
						values: ["true", "false"],
					});
				} else if (schema.type === "enum") {
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: String(currentValue ?? schema.default ?? ""),
						submenu: (cv, done) =>
							new ConfigEnumSubmenu(
								key,
								schema.description || `Select value for ${key}`,
								schema.values,
								cv,
								value => {
									this.callbacks.onConfigChange(key, value);
									done(value);
								},
								() => done(),
							),
					});
				} else {
					// string or number - show as submenu with input
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: displayValue,
						submenu: (cv, done) =>
							new ConfigInputSubmenu(
								key,
								schema,
								cv === "(not set)" ? "" : cv,
								value => {
									const parsed = schema.type === "number" ? Number(value) : value;
									this.callbacks.onConfigChange(key, parsed);
									done(String(value));
								},
								() => done(),
							),
					});
				}
			}
		}

		this.#settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__enabled__") {
					this.callbacks.onEnabledChange(newValue === "true");
					this.plugin = { ...this.plugin, enabled: newValue === "true" };
				} else if (id.startsWith("feature:")) {
					const featName = id.slice(8);
					this.callbacks.onFeatureChange(featName, newValue === "true");
					// Update local state
					const current = new Set(this.plugin.enabledFeatures ?? []);
					if (newValue === "true") {
						current.add(featName);
					} else {
						current.delete(featName);
					}
					this.plugin = { ...this.plugin, enabledFeatures: [...current] };
				} else if (id.startsWith("config:")) {
					const key = id.slice(7);
					const schema = this.plugin.manifest.settings?.[key];
					if (schema?.type === "boolean") {
						this.callbacks.onConfigChange(key, newValue === "true");
					}
				}
			},
			this.callbacks.onBack,
		);

		this.addChild(this.#settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit · Esc to go back"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		if (!this.#settingsList) return;
		this.#settingsList.handleInput(data);
	}
}

// =============================================================================
// Marketplace Plugin Detail Component (read-only metadata + enable toggle)
// =============================================================================

export interface MarketplacePluginDetailCallbacks {
	/** Called when the user toggles enabled state. */
	onEnabledChange: (enabled: boolean) => void;
	/** Called when the user presses Esc to leave the detail view. */
	onBack: () => void;
}

/**
 * Detail view for a marketplace-installed plugin. Marketplace plugins don't
 * expose npm-plugin features/config schemas in the registry, so this view is
 * deliberately minimal: a single Enabled toggle plus read-only install metadata.
 */
export class MarketplacePluginDetailComponent extends Container {
	#settingsList!: SettingsList;

	constructor(
		private plugin: InstalledPluginSummary,
		private readonly callbacks: MarketplacePluginDetailCallbacks,
	) {
		super();
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();

		const plugin = this.plugin;
		const first = plugin.entries[0];
		const enabled = first?.enabled !== false;

		// Header
		this.addChild(new Text(theme.bold(theme.fg("accent", plugin.id)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `Marketplace plugin (${plugin.scope})`), 0, 0));
		if (plugin.shadowedBy) {
			this.addChild(new Text(theme.fg("muted", "Shadowed by project-scoped install"), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "__enabled__",
				label: "Enabled",
				description: "Enable or disable this marketplace plugin",
				currentValue: enabled ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.#settingsList = new SettingsList(
			items,
			items.length,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__enabled__") {
					const next = newValue === "true";
					this.callbacks.onEnabledChange(next);
					// Update local view-state so subsequent toggles reflect the new value.
					if (first) {
						this.plugin = {
							...this.plugin,
							entries: this.plugin.entries.map((e, i) => (i === 0 ? { ...e, enabled: next } : e)),
						};
					}
				}
			},
			this.callbacks.onBack,
		);

		this.addChild(this.#settingsList);
		this.addChild(new Spacer(1));

		// Read-only metadata
		if (first) {
			this.addChild(new Text(theme.fg("muted", `Version:        ${first.version}`), 0, 0));
			this.addChild(new Text(theme.fg("muted", `Installed at:   ${first.installedAt}`), 0, 0));
			this.addChild(new Text(theme.fg("muted", `Last updated:   ${first.lastUpdated}`), 0, 0));
			if (first.gitCommitSha) {
				this.addChild(new Text(theme.fg("muted", `Git commit:     ${first.gitCommitSha}`), 0, 0));
			}
			this.addChild(new Text(theme.fg("muted", `Install path:   ${first.installPath}`), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("dim", "Manage with /plugins, /marketplace, or omp plugin uninstall <id>"), 0, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to toggle · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		if (!this.#settingsList) return;
		this.#settingsList.handleInput(data);
	}
}

// =============================================================================
// Config Submenus
// =============================================================================

/**
 * Submenu for enum config values.
 */
class ConfigEnumSubmenu extends Container {
	#selectList: SelectList;

	constructor(
		key: string,
		description: string,
		values: string[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", key)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SelectItem[] = values.map(v => ({ value: v, label: v }));
		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());

		const currentIndex = values.indexOf(currentValue);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => onSelect(item.value);
		this.#selectList.onCancel = onCancel;

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

/**
 * Submenu for string/number config values with text input.
 */
class ConfigInputSubmenu extends Container {
	#input: Input;

	constructor(
		key: string,
		schema: PluginSettingSchema,
		currentValue: string,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", key)), 0, 0));
		if (schema.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", schema.description), 0, 0));
		}

		// Type hint
		let hint = `Type: ${schema.type}`;
		if (schema.type === "number") {
			const numSchema = schema as { min?: number; max?: number };
			if (numSchema.min !== undefined || numSchema.max !== undefined) {
				hint += ` (${numSchema.min ?? ""}..${numSchema.max ?? ""})`;
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));

		this.addChild(new Spacer(1));

		// Input field
		this.#input = new Input();
		if (!schema.secret && currentValue) {
			this.#input.setValue(currentValue);
		}

		this.#input.onSubmit = value => {
			if (value.trim()) {
				this.onSubmit(value);
			} else {
				this.onCancel();
			}
		};

		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

// =============================================================================
// Main Plugin Settings Selector
// =============================================================================

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: () => void;
}

/** Component with handleInput method */
interface InputHandler {
	handleInput(data: string): void;
}

/**
 * Top-level plugin settings component.
 * Manages navigation between plugin list and plugin detail views.
 */
export class PluginSettingsComponent extends Container {
	#cwd: string;
	#npmManager: PluginManager;
	#marketplaceManager: MarketplaceManager | null = null;
	#viewComponent: (Container & InputHandler) | null = null;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	#currentView: "list" | "detail" | "marketplace-detail" = "list";
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	#currentPlugin: InstalledPlugin | InstalledPluginSummary | null = null;

	constructor(
		cwd: string,
		private readonly callbacks: PluginSettingsCallbacks,
	) {
		super();
		this.#cwd = cwd;
		this.#npmManager = new PluginManager(cwd);
		this.#showPluginList();
	}

	async #getMarketplaceManager(): Promise<MarketplaceManager> {
		if (this.#marketplaceManager) return this.#marketplaceManager;
		this.#marketplaceManager = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(this.#cwd),
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});
		return this.#marketplaceManager;
	}

	async #showPluginList(): Promise<void> {
		this.#currentView = "list";
		this.#currentPlugin = null;
		this.clear();

		const npmPlugins = await this.#npmManager.list();
		let marketplacePlugins: InstalledPluginSummary[] = [];
		try {
			const mgr = await this.#getMarketplaceManager();
			marketplacePlugins = await mgr.listInstalledPlugins();
		} catch {
			// Marketplace registry may not exist on first run — treat as empty.
			marketplacePlugins = [];
		}

		const entries: PluginListEntry[] = [
			...npmPlugins.map<PluginListEntry>(plugin => ({ kind: "npm", plugin })),
			...marketplacePlugins.map<PluginListEntry>(plugin => ({ kind: "marketplace", plugin })),
		];

		this.#viewComponent = new PluginListComponent(entries, {
			onPluginSelect: entry => {
				if (entry.kind === "npm") {
					this.#showPluginDetail(entry.plugin);
				} else {
					this.#showMarketplaceDetail(entry.plugin);
				}
			},
			onCancel: () => this.callbacks.onClose(),
		});

		this.addChild(this.#viewComponent);
	}

	#showPluginDetail(plugin: InstalledPlugin): void {
		this.#currentView = "detail";
		this.#currentPlugin = plugin;
		this.clear();

		this.#viewComponent = new PluginDetailComponent(plugin, this.#npmManager, {
			onEnabledChange: async enabled => {
				await this.#npmManager.setEnabled(plugin.name, enabled);
				this.callbacks.onPluginChanged();
			},
			onFeatureChange: async (feature, enabled) => {
				const current = new Set((await this.#npmManager.getEnabledFeatures(plugin.name)) ?? []);
				if (enabled) {
					current.add(feature);
				} else {
					current.delete(feature);
				}
				await this.#npmManager.setEnabledFeatures(plugin.name, [...current]);
				this.callbacks.onPluginChanged();
			},
			onConfigChange: async (key, value) => {
				await this.#npmManager.setPluginSetting(plugin.name, key, value);
				this.callbacks.onPluginChanged();
			},
			onBack: () => this.#showPluginList(),
		});

		this.addChild(this.#viewComponent);
	}

	#showMarketplaceDetail(plugin: InstalledPluginSummary): void {
		this.#currentView = "marketplace-detail";
		this.#currentPlugin = plugin;
		this.clear();

		this.#viewComponent = new MarketplacePluginDetailComponent(plugin, {
			onEnabledChange: async enabled => {
				try {
					const mgr = await this.#getMarketplaceManager();
					await mgr.setPluginEnabled(plugin.id, enabled, plugin.scope);
					this.callbacks.onPluginChanged();
				} catch {
					// Best-effort: registry mismatch surfaces in the slash command;
					// here we silently keep the local view-state.
				}
			},
			onBack: () => this.#showPluginList(),
		});

		this.addChild(this.#viewComponent);
	}

	handleInput(data: string): void {
		this.#viewComponent?.handleInput(data);
	}
}
