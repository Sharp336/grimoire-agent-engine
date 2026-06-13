import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "./model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "./model-resolver";
import { MODEL_ROLE_IDS } from "./model-roles";
import type { Settings } from "./settings";

export const BUILTIN_MODEL_PRESET_IDS = ["budget", "balanced", "smart", "ultra"] as const;
export type BuiltInModelPresetId = (typeof BUILTIN_MODEL_PRESET_IDS)[number];
/** Any preset id — a built-in or a user-defined custom preset key. */
export type ModelPresetId = string;

export interface ModelPresetInfo {
	id: ModelPresetId;
	label: string;
	description: string;
}

export type ModelPresetRoleMap = Record<string, string>;
export type ModelPresetOverrides = Record<string, ModelPresetRoleMap>;

export interface ResolvedModelPresetRole {
	role: string;
	selector: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
}

export interface ResolvedModelPreset {
	id: ModelPresetId;
	info: ModelPresetInfo;
	roles: ResolvedModelPresetRole[];
	defaultRole: ResolvedModelPresetRole;
}

const MODEL_PRESET_INFOS: Record<BuiltInModelPresetId, ModelPresetInfo> = {
	budget: {
		id: "budget",
		label: "Budget",
		description: "Use the fastest economical model profile for every role.",
	},
	balanced: {
		id: "balanced",
		label: "Balanced",
		description: "Use the normal default role with slower models for planning.",
	},
	smart: {
		id: "smart",
		label: "Smart",
		description: "Use thinking models with high reasoning for complex work.",
	},
	ultra: {
		id: "ultra",
		label: "Ultra",
		description: "Use the strongest thinking profile for every heavy role.",
	},
};

const BALANCED_PRESET: ModelPresetRoleMap = {
	default: "pi/default",
	smol: "pi/smol",
	slow: "pi/slow",
	plan: "pi/slow",
	task: "pi/default",
	commit: "pi/default",
	designer: "pi/designer",
};

const SMART_PRESET: ModelPresetRoleMap = {
	default: "pi/slow:high",
	smol: "pi/smol",
	slow: "pi/slow:high",
	plan: "pi/slow:high",
	task: "pi/slow:high",
	commit: "pi/slow:high",
	designer: "pi/designer:high",
};

const ULTRA_PRESET: ModelPresetRoleMap = {
	default: "pi/slow:xhigh",
	smol: "pi/slow:high",
	slow: "pi/slow:xhigh",
	plan: "pi/slow:xhigh",
	task: "pi/slow:xhigh",
	commit: "pi/slow:xhigh",
	designer: "pi/designer:xhigh",
};

function getBudgetPreset(settings: Settings): ModelPresetRoleMap {
	const preset: ModelPresetRoleMap = {
		default: "pi/smol",
		smol: "pi/smol",
		slow: "pi/smol",
		plan: "pi/smol",
		task: "pi/smol",
		commit: "pi/smol",
		designer: "pi/smol",
	};
	if (settings.getModelRole("vision")) {
		preset.vision = "pi/vision";
	}
	return preset;
}

function getBuiltInModelPresetRoleMap(settings: Settings, id: BuiltInModelPresetId): ModelPresetRoleMap {
	switch (id) {
		case "budget":
			return getBudgetPreset(settings);
		case "balanced":
			return { ...BALANCED_PRESET };
		case "smart":
			return { ...SMART_PRESET };
		case "ultra":
			return { ...ULTRA_PRESET };
	}
}

function stringRoleMap(value: unknown): ModelPresetRoleMap | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const roles: ModelPresetRoleMap = {};
	for (const [role, selector] of Object.entries(value)) {
		if (typeof selector === "string" && selector.trim()) {
			roles[role] = selector;
		}
	}
	return roles;
}

export function isBuiltInModelPresetId(value: string): value is BuiltInModelPresetId {
	return (BUILTIN_MODEL_PRESET_IDS as readonly string[]).includes(value);
}

/** All preset ids: the four built-ins (in order) then custom keys in definition order. */
export function getAllModelPresetIds(settings: Settings): ModelPresetId[] {
	const ids: ModelPresetId[] = [...BUILTIN_MODEL_PRESET_IDS];
	for (const key of Object.keys(settings.getModelPresets())) {
		if (!isBuiltInModelPresetId(key)) ids.push(key);
	}
	return ids;
}

/** Resolve a raw preset name (case-insensitive exact match) to a known preset id. */
export function resolvePresetId(settings: Settings, raw: string): ModelPresetId | undefined {
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return undefined;
	return getAllModelPresetIds(settings).find(id => id.toLowerCase() === normalized);
}

export function getModelPresetInfo(id: ModelPresetId): ModelPresetInfo {
	if (isBuiltInModelPresetId(id)) return MODEL_PRESET_INFOS[id];
	return { id, label: id, description: "Custom preset." };
}

export function getModelPresetRoleMap(settings: Settings, id: ModelPresetId): ModelPresetRoleMap {
	if (isBuiltInModelPresetId(id)) {
		const roles = getBuiltInModelPresetRoleMap(settings, id);
		const override = settings.getModelPreset(id);
		return override ? { ...roles, ...override } : roles;
	}
	const custom = settings.getModelPreset(id);
	return custom ? { ...custom } : {};
}

export function resolveModelPreset(
	settings: Settings,
	modelRegistry: ModelRegistry,
	availableModels: readonly Model<Api>[],
	id: ModelPresetId,
): ResolvedModelPreset {
	const info = getModelPresetInfo(id);
	const roleMap = getModelPresetRoleMap(settings, id);
	if (Object.keys(roleMap).length === 0) {
		throw new Error(`Unknown preset: ${id}`);
	}
	const available = [...availableModels];
	const matchPreferences = getModelMatchPreferences(settings);
	const roles: ResolvedModelPresetRole[] = [];

	for (const role of orderPresetRoles(roleMap)) {
		const selector = roleMap[role];
		if (!selector) continue;
		const resolved = resolveModelRoleValue(selector, available, {
			settings,
			matchPreferences,
			modelRegistry,
			roleLookup: r => settings.getBaseModelRole(r),
		});
		if (!resolved.model) {
			throw new Error(`Preset ${info.label} cannot resolve role ${role}: ${selector}`);
		}
		roles.push({
			role,
			selector,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			explicitThinkingLevel: resolved.explicitThinkingLevel,
		});
	}

	const defaultRole = roles.find(role => role.role === "default");
	if (!defaultRole) {
		throw new Error(`Preset ${info.label} cannot resolve role default: ${roleMap.default ?? ""}`);
	}

	return { id, info, roles, defaultRole };
}

function orderPresetRoles(roleMap: ModelPresetRoleMap): string[] {
	const roles = new Set<string>();
	for (const role of MODEL_ROLE_IDS) {
		if (role in roleMap) roles.add(role);
	}
	for (const role of Object.keys(roleMap)) roles.add(role);
	return [...roles];
}

export function modelPresetsFromUnknown(value: unknown): ModelPresetOverrides {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const presets: ModelPresetOverrides = {};
	for (const [key, item] of Object.entries(value)) {
		const id = key.trim();
		const roles = stringRoleMap(item);
		if (id && roles) {
			presets[id] = roles;
		}
	}
	return presets;
}
