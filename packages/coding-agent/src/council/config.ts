import { isRecord } from "@oh-my-pi/pi-utils";
import { type ModelRoleLookup, resolveConfiguredModelPatterns } from "../config/model-resolver";
import { getDefault, type Settings } from "../config/settings";

export type { CouncilMemberSetting } from "../config/settings";
export const COUNCIL_ROLE_ID_MAX_LENGTH = 64;
/** Grammar for council roster role identifiers. */
export const COUNCIL_ROLE_ID = /^[a-z][a-z0-9]{0,63}$/;

export interface CouncilMember {
	role: string;
	enabled: boolean;
	/** Zero-based position in the configured roster. */
	order: number;
}

export interface CouncilConfig {
	members: CouncilMember[];
	rounds: 1 | 2;
}

export class CouncilConfigError extends Error {
	constructor(
		readonly settingPath: string,
		message: string,
	) {
		super(message);
		this.name = "CouncilConfigError";
	}
}

function parseMember(value: unknown, index: number): CouncilMember {
	const settingPath = `council.members[${index}]`;
	if (!isRecord(value)) {
		throw new CouncilConfigError(
			settingPath,
			`${settingPath}: expected { role: string, enabled: boolean }, got ${typeof value}`,
		);
	}
	const keys = Object.keys(value);
	if (
		keys.length !== 2 ||
		!Object.hasOwn(value, "role") ||
		!Object.hasOwn(value, "enabled") ||
		keys.some(key => key !== "role" && key !== "enabled") ||
		typeof value.enabled !== "boolean"
	) {
		throw new CouncilConfigError(
			settingPath,
			`${settingPath}: expected { role: string, enabled: boolean }, got ${typeof value}`,
		);
	}
	if (typeof value.role !== "string") {
		throw new CouncilConfigError(
			settingPath,
			`${settingPath}: expected { role: string, enabled: boolean }, got ${typeof value}`,
		);
	}
	if (!COUNCIL_ROLE_ID.test(value.role)) {
		throw new CouncilConfigError(
			`${settingPath}.role`,
			`${settingPath}.role: ${JSON.stringify(value.role)} must match /^[a-z][a-z0-9]{0,63}$/`,
		);
	}
	return { role: value.role, enabled: value.enabled, order: index };
}

export type CouncilMemberSelectorResolution =
	| { kind: "unassigned" }
	| { kind: "invalid" }
	| { kind: "resolved"; selector: string };

/**
 * Resolve only an explicitly configured Council roster selector chain.
 * Built-in role priorities are intentionally excluded: those are valid for
 * planner selection, not roster pinning.
 */
export function resolveCouncilMemberSelector(settings: Settings, role: string): CouncilMemberSelectorResolution {
	const rawModelRoles = settings.getRawSetting("modelRoles");
	if (!rawModelRoles.configured || !isRecord(rawModelRoles.value) || !Object.hasOwn(rawModelRoles.value, role)) {
		return { kind: "unassigned" };
	}
	const modelRoles = rawModelRoles.value;
	const roleLookup: ModelRoleLookup = {
		getModelRole(candidate) {
			const value = modelRoles[candidate];
			return typeof value === "string" ? value : undefined;
		},
		getModelRolePatterns(candidate) {
			if (!Object.hasOwn(modelRoles, candidate)) return undefined;
			const value = modelRoles[candidate];
			if (typeof value === "string") return value;
			if (Array.isArray(value) && value.every(pattern => typeof pattern === "string")) return value;
			return [];
		},
	};
	const value = modelRoles[role];
	const selectors =
		typeof value === "string" || (Array.isArray(value) && value.every(pattern => typeof pattern === "string"))
			? resolveConfiguredModelPatterns(value, roleLookup, { fallbackToRoleDefaults: false })
			: [];
	return selectors.length === 1 ? { kind: "resolved", selector: selectors[0] } : { kind: "invalid" };
}

/** Parse and validate the effective council configuration without normalizing malformed input. */
export function parseCouncilConfig(settings: Settings): CouncilConfig {
	const projectMembers = settings.getRawSetting("council.members", "project");
	if (projectMembers.configured) {
		const globalPath = settings.getGlobalConfigPath();
		throw new CouncilConfigError(
			"council.members",
			`council.members: defined in project settings, which council does not support; move it to ${globalPath}`,
		);
	}

	const globalMembers = settings.getRawSetting("council.members", "global");
	if (globalMembers.configured && (globalMembers.blockedByParent || !Array.isArray(globalMembers.value))) {
		throw new CouncilConfigError("council.members", "council.members: expected an array");
	}

	const rawMembers = settings.getRawSetting("council.members");
	const memberValues = rawMembers.configured ? rawMembers.value : getDefault("council.members");
	if (!Array.isArray(memberValues)) {
		throw new CouncilConfigError("council.members", "council.members: expected an array");
	}

	const roster = Array.from(memberValues, parseMember);
	const seen = new Map<string, number>();
	for (const member of roster) {
		const duplicateIndex = seen.get(member.role);
		if (duplicateIndex !== undefined) {
			const settingPath = `council.members[${member.order}].role`;
			throw new CouncilConfigError(
				settingPath,
				`${settingPath}: ${member.role} duplicates council.members[${duplicateIndex}].role`,
			);
		}
		seen.set(member.role, member.order);
	}

	for (const member of roster) {
		const resolution = resolveCouncilMemberSelector(settings, member.role);
		if (resolution.kind === "resolved" || resolution.kind === "unassigned") continue;

		const settingPath = `council.members[${member.order}].role`;
		throw new CouncilConfigError(
			settingPath,
			`${settingPath} ${member.role}: model role must resolve to exactly one terminal model selector`,
		);
	}

	const rawRounds = settings.getRawSetting("council.rounds");
	const rounds = rawRounds.configured ? rawRounds.value : getDefault("council.rounds");
	if (rounds !== 1 && rounds !== 2) {
		throw new CouncilConfigError("council.rounds", `council.rounds: expected 1 or 2, got ${String(rounds)}`);
	}

	return {
		members: roster,
		rounds,
	};
}
