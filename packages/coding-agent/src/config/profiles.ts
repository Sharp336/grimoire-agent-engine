type ProfileSettings = Record<string, unknown>;

export const CONFIG_PROFILE_IDS = ["developer", "current", "enterprise", "minimal"] as const;

export type ConfigProfileId = (typeof CONFIG_PROFILE_IDS)[number];

export interface ConfigProfileDefinition {
	id: ConfigProfileId;
	description: string;
	settings: ProfileSettings;
}

const EMPTY_PROFILE_SETTINGS: ProfileSettings = {};

const ENTERPRISE_PROFILE_SETTINGS: ProfileSettings = {
	mcp: {
		enableProjectConfig: false,
		discoveryMode: true,
	},
	skills: {
		enableClaudeProject: false,
		enablePiProject: false,
	},
	commands: {
		enableClaudeProject: false,
	},
};

const MINIMAL_PROFILE_SETTINGS: ProfileSettings = {
	statusLine: {
		preset: "minimal",
	},
	symbolPreset: "ascii",
};

const CONFIG_PROFILE_DEFINITIONS: Record<ConfigProfileId, ConfigProfileDefinition> = {
	developer: {
		id: "developer",
		description: "Preserves the current developer-oriented UX defaults.",
		settings: EMPTY_PROFILE_SETTINGS,
	},
	current: {
		id: "current",
		description: "Compatibility alias for the current developer-oriented defaults.",
		settings: EMPTY_PROFILE_SETTINGS,
	},
	enterprise: {
		id: "enterprise",
		description: "Turns off project-loaded commands and skills; managed policy is unaffected.",
		settings: ENTERPRISE_PROFILE_SETTINGS,
	},
	minimal: {
		id: "minimal",
		description: "Uses a quieter terminal presentation with a minimal status line and ASCII symbols.",
		settings: MINIMAL_PROFILE_SETTINGS,
	},
};

export function resolveConfigProfileId(value: unknown): ConfigProfileId | null {
	if (typeof value !== "string") {
		return null;
	}
	return CONFIG_PROFILE_IDS.includes(value as ConfigProfileId) ? (value as ConfigProfileId) : null;
}

export function getConfigProfileSettings(profileId: ConfigProfileId): ProfileSettings {
	return structuredClone(CONFIG_PROFILE_DEFINITIONS[profileId].settings);
}

export function listConfigProfiles(): ConfigProfileDefinition[] {
	return CONFIG_PROFILE_IDS.map(profileId => {
		const definition = CONFIG_PROFILE_DEFINITIONS[profileId];
		return {
			id: definition.id,
			description: definition.description,
			settings: structuredClone(definition.settings),
		};
	});
}
