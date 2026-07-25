/**
 * Transport-neutral view of the settings schema for external clients.
 *
 * Built here rather than serialized ad hoc at each boundary so RPC, and any
 * later consumer, share one disclosure decision. `SETTINGS_SCHEMA` itself is
 * compiled-in public information, so metadata is always included; the user's
 * configured value is not, and is emitted only for settings explicitly marked
 * `rpcReadable`.
 */
import type { Settings } from "./settings";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	isRpcReadable,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
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
	/** Present only when the setting is `rpcReadable` and not `secret`. */
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
	/** Present only for settings the settings panel can display. */
	ui?: {
		tab: SettingTab;
		group?: string;
		label: string;
		description: string;
		condition?: string;
		secret: boolean;
	};
}

export interface SettingsSnapshot {
	settings: SettingSnapshotEntry[];
}

/**
 * A value may be disclosed only when the schema opts it in. `secret` is
 * honored as a second, independent veto so a setting cannot be disclosed by
 * annotating it and forgetting the masking flag.
 */
function disclosesValue(path: SettingPath): boolean {
	if (!isRpcReadable(path)) return false;
	return getUi(path)?.secret !== true;
}

export function buildSettingsSnapshot(settings: Settings, tab?: SettingTab): SettingsSnapshot {
	const entries: SettingSnapshotEntry[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const ui = getUi(path);
		if (tab !== undefined && ui?.tab !== tab) continue;
		const values = getEnumValues(path);
		const entry: SettingSnapshotEntry = {
			path,
			type: getType(path),
			...(getDefault(path) === undefined ? {} : { default: getDefault(path) }),
			...(values ? { values } : {}),
			...(ui
				? {
						ui: {
							tab: ui.tab,
							...(ui.group === undefined ? {} : { group: ui.group }),
							label: ui.label,
							description: ui.description,
							...(ui.condition === undefined ? {} : { condition: ui.condition }),
							secret: ui.secret === true,
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
	return { settings: entries };
}
