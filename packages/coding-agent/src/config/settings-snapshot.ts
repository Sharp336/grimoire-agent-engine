/**
 * Transport-neutral view of the settings schema for external clients.
 *
 * Built here rather than serialized ad hoc at each boundary so RPC, and any
 * later consumer, share one disclosure decision. `SETTINGS_SCHEMA` itself is
 * compiled-in public information, so metadata is always included; the user's
 * configured value is not, and is emitted only for settings explicitly marked
 * `rpcReadable`.
 */
import {
	getSettingPanelControlKind,
	isSettingPanelRenderable,
	isSettingPanelVisible,
	type SettingPanelControlKind,
} from "../modes/components/settings-defs";
import type { Settings } from "./settings";
import {
	getDefault,
	getDescription,
	getEnumValues,
	getType,
	getUi,
	isCredential,
	isRpcReadable,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
	TAB_METADATA,
} from "./settings-schema";

/**
 * RPC frames are cast from parsed JSON rather than validated, so the
 * `SettingTab` annotation guarantees nothing at runtime. A typo must fail
 * loudly instead of quietly selecting no settings at all.
 */
export function isSettingTab(value: unknown): value is SettingTab {
	return typeof value === "string" && (SETTING_TABS as readonly string[]).includes(value);
}

/** One setting's public shape, plus its value when disclosure is allowed. */
export interface SettingSnapshotEntry {
	path: string;
	type: string;
	/**
	 * Compiled-in default, always safe because it is a constant in this
	 * repository. Omitted entirely when the setting has no default: JSON drops
	 * an undefined field, so declaring it required would describe a shape the
	 * wire never produces.
	 */
	default?: unknown;
	/** Present only when the setting is `rpcReadable` and not credential-marked. */
	value?: unknown;
	/** True when the value was withheld. Absent when `value` is present. */
	redacted?: true;
	/**
	 * True when the user has explicitly configured this setting. Present only
	 * alongside a disclosed value: whether a credential is set is user state,
	 * not compiled-in metadata, so a redacted entry reveals nothing at all.
	 */
	configured?: boolean;
	/** Allowed values for an enum setting. */
	values?: readonly string[];
	/**
	 * Prose for a setting with no panel entry, which keeps its description at
	 * the top level rather than inside `ui`.
	 */
	description?: string;
	/**
	 * Schema UI metadata. Absence means no panel control. When present,
	 * `renderable` is authoritative: some config-only number and array settings
	 * retain this metadata but have no panel control.
	 */
	ui?: {
		tab: SettingTab;
		group?: string;
		label: string;
		description: string;
		/** Exact control variant used by the built-in settings panel, or null when config-only. */
		control: SettingPanelControlKind | null;
		renderable: boolean;
		/** Whether that control is currently visible after evaluating its condition. */
		visible: boolean;
		/** Present only when the panel treats the setting value as secret. */
		secret?: true;
		/**
		 * Choice metadata. `"runtime"` is preserved verbatim rather than resolved:
		 * the effective choices depend on runtime state this response does not
		 * expose, and a client must be able to tell "populated elsewhere" from
		 * "no choices".
		 */
		options?: ReadonlyArray<SubmenuOption> | "runtime";
		/** Selection order is meaningful and the editor supports reordering. */
		ordered?: boolean;
	};
}

/** Canonical tab and section order needed to reproduce the built-in panel layout. */
export interface SettingsTabSnapshot {
	id: SettingTab;
	label: string;
	icon: `tab.${string}`;
	/** Ordered named sections. Ungrouped settings render before these sections. */
	groups: readonly string[];
}

export interface SettingsSnapshot {
	tabs: SettingsTabSnapshot[];
	settings: SettingSnapshotEntry[];
}

/**
 * A value may be disclosed only when the schema opts it in. The canonical
 * credential marker is an independent veto, so adding `rpcReadable` can never
 * weaken the redaction invariant.
 */
function disclosesValue(path: SettingPath): boolean {
	return isRpcReadable(path) && !isCredential(path);
}

function getSnapshotOptions(path: SettingPath): ReadonlyArray<SubmenuOption> | "runtime" | undefined {
	const options = getUi(path)?.options;
	if (options === undefined) return undefined;

	// The panel narrows these schema choices using state the RPC snapshot does
	// not disclose: the active model's thinking efforts and the excluded web
	// search providers. Do not advertise the unfiltered schema lists as the
	// effective choices.
	if (path === "defaultThinkingLevel" || path === "providers.webSearchOrder") return "runtime";
	return options;
}

export function buildSettingsSnapshot(settings: Settings, tab?: SettingTab): SettingsSnapshot {
	const entries: SettingSnapshotEntry[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const ui = getUi(path);
		const options = getSnapshotOptions(path);
		const renderable = isSettingPanelRenderable(path);
		if (tab !== undefined && ui?.tab !== tab) continue;
		const values = getEnumValues(path);
		const description = getDescription(path);
		const entry: SettingSnapshotEntry = {
			path,
			type: getType(path),
			...(getDefault(path) === undefined ? {} : { default: getDefault(path) }),
			...(values ? { values } : {}),
			...(description === undefined ? {} : { description }),
			...(ui
				? {
						ui: {
							tab: ui.tab,
							...(ui.group === undefined ? {} : { group: ui.group }),
							label: ui.label,
							description: ui.description,
							renderable,
							control: getSettingPanelControlKind(path),
							visible: renderable && isSettingPanelVisible(path, settings),
							...(isCredential(path) ? { secret: true } : {}),
							...(options === undefined ? {} : { options }),
							...(ui.ordered === undefined ? {} : { ordered: ui.ordered }),
						},
					}
				: {}),
		};
		if (disclosesValue(path)) {
			entry.value = settings.get(path);
			entry.configured = settings.isConfigured(path);
		} else entry.redacted = true;
		entries.push(entry);
	}
	const tabs = (tab === undefined ? SETTING_TABS : [tab]).map(id => ({
		id,
		...TAB_METADATA[id],
		groups: TAB_GROUPS[id],
	}));
	return { tabs, settings: entries };
}
