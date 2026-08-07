/** Voices accepted by Codex-backed realtime sessions. */
export const CODEX_LIVE_VOICE_OPTIONS = [
	{ value: "arbor", label: "Arbor" },
	{ value: "breeze", label: "Breeze" },
	{ value: "cove", label: "Cove" },
	{ value: "ember", label: "Ember" },
	{ value: "juniper", label: "Juniper" },
	{ value: "maple", label: "Maple" },
	{ value: "sol", label: "Sol" },
	{ value: "spruce", label: "Spruce" },
	{ value: "vale", label: "Vale" },
] as const;

/** Voices accepted by Grok-backed realtime sessions. */
export const GROK_LIVE_VOICE_OPTIONS = [
	{ value: "eve", label: "Eve" },
	{ value: "ara", label: "Ara" },
	{ value: "rex", label: "Rex" },
	{ value: "sal", label: "Sal" },
	{ value: "leo", label: "Leo" },
] as const;

export const CODEX_LIVE_VOICE_VALUES = CODEX_LIVE_VOICE_OPTIONS.map(({ value }) => value);
export const GROK_LIVE_VOICE_VALUES = GROK_LIVE_VOICE_OPTIONS.map(({ value }) => value);

export const GROK_LIVE_VOICE_LOOKUP: Readonly<Record<string, true>> = {
	eve: true,
	ara: true,
	rex: true,
	sal: true,
	leo: true,
};

export const DEFAULT_CODEX_LIVE_VOICE = "sol";
export const DEFAULT_GROK_LIVE_VOICE = "eve";
