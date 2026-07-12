import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../thinking";
import { resolveModelRoleValue } from "./model-resolver";
import type { Settings } from "./settings";
import type { ProfileSnapshot } from "./settings-schema";

/** Get all profiles as a typed record. */
export function getProfiles(settings: Settings): Record<string, ProfileSnapshot> {
	const value = settings.get("profiles");
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, ProfileSnapshot>;
}

/** Get sorted profile names. */
export function getProfileNames(settings: Settings): string[] {
	return Object.keys(getProfiles(settings)).sort((a, b) => a.localeCompare(b));
}

/** Save the current model configuration as a named profile. Overwrites if exists. */
export function saveProfile(settings: Settings, name: string): void {
	const modelRoles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(settings.getModelRoles())) {
		if (selector) modelRoles[role] = selector;
	}
	const defaultThinkingLevel = settings.get("defaultThinkingLevel");
	const snapshot: ProfileSnapshot = {
		modelRoles,
		defaultThinkingLevel,
	};
	const profiles = { ...getProfiles(settings) };
	profiles[name] = snapshot;
	settings.set("profiles", profiles);
}

/**
 * Switch to a named profile. Replaces the entire modelRoles record and
 * defaultThinkingLevel — clean cutover, NOT a merge. This ensures stale
 * role assignments from the previously-active profile are removed.
 *
 * Returns true if the profile existed and was applied.
 */
export function switchProfile(settings: Settings, name: string): boolean {
	const profiles = getProfiles(settings);
	const profile = profiles[name];
	if (!profile) return false;
	settings.set("modelRoles", profile.modelRoles);
	if (profile.defaultThinkingLevel !== undefined) {
		settings.set("defaultThinkingLevel", profile.defaultThinkingLevel);
	}
	return true;
}

/** Delete a named profile. Returns true if it existed. */
export function deleteProfile(settings: Settings, name: string): boolean {
	const profiles = { ...getProfiles(settings) };
	if (!(name in profiles)) return false;
	delete profiles[name];
	settings.set("profiles", profiles);
	return true;
}

export interface ProfileSwitchResult {
	ok: boolean;
	model?: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * Switch to a named profile and resolve the default role's model + thinking
 * level from the available models. Returns the resolved model and thinking
 * level so the caller can apply them to the live session.
 *
 * This is the single source of truth for profile switching — the slash
 * command handlers and the interactive picker all call this.
 */
export function switchProfileAndResolve(
	settings: Settings,
	name: string,
	availableModels: ReadonlyArray<Model>,
): ProfileSwitchResult {
	const ok = switchProfile(settings, name);
	if (!ok) return { ok: false };
	const defaultRole = settings.getModelRole("default");
	if (!defaultRole) return { ok: true };
	const resolved = resolveModelRoleValue(defaultRole, availableModels as Model[], {
		settings,
	});
	return {
		ok: true,
		model: resolved.model,
		thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
	};
}
