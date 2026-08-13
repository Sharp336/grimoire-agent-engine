import { isRecord } from "@oh-my-pi/pi-utils";
import { type ModelRoleLookup, resolveConfiguredModelPatterns } from "../config/model-resolver";
import { getDefault, type Settings } from "../config/settings";

export type { CouncilMemberSetting } from "../config/settings";
export const COUNCIL_ROLE_ID_MAX_LENGTH = 64;
/** Grammar for council roster role identifiers. */
export const COUNCIL_ROLE_ID = /^[a-z][a-z0-9]{0,63}$/;

/** Model role driving the council planner. Reserved: it is a lead, never a roster slot. */
export const COUNCIL_PLANNER_ROLE = "planner";
/** Model role driving a delegated council adjudicator. Reserved: it is a lead, never a roster slot. */
export const COUNCIL_ADJUDICATOR_ROLE = "adjudicator";
/** The two reserved lead roles, in presentation order. */
export const COUNCIL_LEAD_ROLES: readonly string[] = [COUNCIL_PLANNER_ROLE, COUNCIL_ADJUDICATOR_ROLE];

/** Per-role advisor opt-in. Each flag attaches a live advisor to that council role's own turns. */
export interface CouncilAdvisorConfig {
	planner: boolean;
	reviewers: boolean;
	/** Applies to a delegated adjudicator only; a Main-mode adjudicator follows `advisor.enabled`. */
	adjudicator: boolean;
}

export interface CouncilMember {
	role: string;
	enabled: boolean;
	/** Zero-based position in the configured roster. */
	order: number;
	/** Pinned review round; omitted means every configured round. */
	round?: 1 | 2;
}

export interface CouncilConfig {
	members: CouncilMember[];
	rounds: 1 | 2;
	advisor: CouncilAdvisorConfig;
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

/** Repair example shared by every `council.members` shape refusal. */
const COUNCIL_MEMBER_EXAMPLE = "{ role: council1, enabled: true, round: 1 }";
const COUNCIL_MEMBER_SHAPE = "{ role: string, enabled: boolean, round?: 1 | 2 }";

function parseMember(globalPath: string, value: unknown, index: number): CouncilMember {
	const settingPath = `council.members[${index}]`;
	const shapeError = (): CouncilConfigError =>
		new CouncilConfigError(
			settingPath,
			`${settingPath}: expected ${COUNCIL_MEMBER_SHAPE}, got ${typeof value}. Edit council.members in ${globalPath}; each entry looks like ${COUNCIL_MEMBER_EXAMPLE}.`,
		);
	if (!isRecord(value)) throw shapeError();
	const keys = Object.keys(value);
	if (
		!Object.hasOwn(value, "role") ||
		!Object.hasOwn(value, "enabled") ||
		keys.some(key => key !== "role" && key !== "enabled" && key !== "round") ||
		typeof value.enabled !== "boolean"
	) {
		throw shapeError();
	}
	if (typeof value.role !== "string") throw shapeError();
	if (!COUNCIL_ROLE_ID.test(value.role)) {
		throw new CouncilConfigError(
			`${settingPath}.role`,
			`${settingPath}.role: ${JSON.stringify(value.role)} must match /^[a-z][a-z0-9]{0,63}$/: a lowercase letter first, then lowercase letters and digits, at most ${COUNCIL_ROLE_ID_MAX_LENGTH} characters.`,
		);
	}
	if (COUNCIL_LEAD_ROLES.includes(value.role)) {
		throw new CouncilConfigError(
			`${settingPath}.role`,
			`${settingPath}.role: '${value.role}' is reserved for the council ${value.role} lead and cannot be a roster member. Rename this member in ${globalPath}; assign the lead through modelRoles.${value.role}.`,
		);
	}
	let round: 1 | 2 | undefined;
	if (Object.hasOwn(value, "round")) {
		if (value.round !== 1 && value.round !== 2) {
			throw new CouncilConfigError(
				`${settingPath}.round`,
				`${settingPath}.round: expected 1 or 2, got ${String(value.round)}. Omit it to run this reviewer in every configured round.`,
			);
		}
		round = value.round;
	}
	return { role: value.role, enabled: value.enabled, order: index, ...(round === undefined ? {} : { round }) };
}

/**
 * Rounds a member actually serves. An omitted `round` means every configured round — today's exact
 * behaviour — and a round pinned above `configuredRounds` yields the empty array, the single
 * canonical encoding of *inert*: parked configuration that never runs and is never clamped
 * elsewhere.
 */
export function councilMemberRounds(member: Pick<CouncilMember, "round">, configuredRounds: number): number[] {
	if (member.round === undefined) {
		return Array.from({ length: Math.max(0, configuredRounds) }, (_unused, index) => index + 1);
	}
	return member.round <= configuredRounds ? [member.round] : [];
}

/**
 * Ceiling on reviewers that actually run in a configured round.
 *
 * This is a *representability* limit, not a fan-out limit: the adjudication grade schema addresses
 * each reviewer by a 1-based `slot`, and `COUNCIL_REVIEWER_GRADE_SCHEMA.properties.slot.maximum` is
 * this same constant, so a 65th active reviewer could be launched and billed but never graded.
 * Simultaneous execution stays governed by `task.maxConcurrency` and provider request limits.
 *
 * Disabled members, and enabled members pinned above `council.rounds`, are parked configuration:
 * they never run, never reach the manifest roster, and are therefore unlimited.
 */
export const COUNCIL_MAX_ACTIVE_REVIEWERS = 64;

/**
 * How many roster members would actually run under `configuredRounds`. The single definition shared
 * by strict config parsing, preflight, resume eligibility, and the Model Hub roster editor.
 */
export function countActiveCouncilMembers(
	members: readonly Pick<CouncilMember, "enabled" | "round">[],
	configuredRounds: number,
): number {
	let count = 0;
	for (const member of members) {
		if (!member.enabled) continue;
		if (councilMemberRounds(member, configuredRounds).length === 0) continue;
		count++;
	}
	return count;
}

export type CouncilMemberSelectorResolution =
	| { kind: "unassigned" }
	| { kind: "invalid"; selectorCount: number }
	| { kind: "resolved"; selector: string };

/**
 * Resolve only an explicitly configured Council selector chain, for a roster slot or for one of the
 * reserved lead roles (`planner`, `adjudicator`). Built-in role priorities are intentionally
 * excluded: a council assignment is always an explicit pin, never a role default.
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
	return selectors.length === 1
		? { kind: "resolved", selector: selectors[0] }
		: { kind: "invalid", selectorCount: selectors.length };
}

function parseAdvisorFlag(settings: Settings, key: "planner" | "reviewers" | "adjudicator"): boolean {
	const settingPath = `council.advisor.${key}` as const;
	const raw = settings.getRawSetting(settingPath);
	const value = raw.configured ? raw.value : getDefault(settingPath);
	if (typeof value !== "boolean") {
		throw new CouncilConfigError(settingPath, `${settingPath}: expected true or false, got ${String(value)}`);
	}
	return value;
}

/** Parse and validate the effective council configuration without normalizing malformed input. */
export function parseCouncilConfig(settings: Settings): CouncilConfig {
	const globalPath = settings.getGlobalConfigPath();
	const projectMembers = settings.getRawSetting("council.members", "project");
	if (projectMembers.configured) {
		throw new CouncilConfigError(
			"council.members",
			`council.members: defined in project settings, which council does not support; move it to ${globalPath}`,
		);
	}

	const globalMembers = settings.getRawSetting("council.members", "global");
	if (globalMembers.configured && (globalMembers.blockedByParent || !Array.isArray(globalMembers.value))) {
		throw new CouncilConfigError(
			"council.members",
			`council.members: expected an array. Edit council.members in ${globalPath}; it looks like [${COUNCIL_MEMBER_EXAMPLE}].`,
		);
	}

	const rawMembers = settings.getRawSetting("council.members");
	const memberValues = rawMembers.configured ? rawMembers.value : getDefault("council.members");
	if (!Array.isArray(memberValues)) {
		throw new CouncilConfigError(
			"council.members",
			`council.members: expected an array. Edit council.members in ${globalPath}; it looks like [${COUNCIL_MEMBER_EXAMPLE}].`,
		);
	}

	const roster = Array.from(memberValues, (value, index) => parseMember(globalPath, value, index));
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
			`${settingPath}: role '${member.role}' maps to ${resolution.selectorCount} models through modelRoles; council members need exactly one concrete provider/model.`,
		);
	}

	const rawRounds = settings.getRawSetting("council.rounds");
	const rounds = rawRounds.configured ? rawRounds.value : getDefault("council.rounds");
	if (rounds !== 1 && rounds !== 2) {
		throw new CouncilConfigError("council.rounds", `council.rounds: expected 1 or 2, got ${String(rounds)}`);
	}

	// Ordered after rounds: whether a pinned member is active at all depends on `council.rounds`, so
	// lowering the rounds is itself one of the two ways to get back under the ceiling.
	const activeCount = countActiveCouncilMembers(roster, rounds);
	if (activeCount > COUNCIL_MAX_ACTIVE_REVIEWERS) {
		throw new CouncilConfigError(
			"council.members",
			`council.members: ${activeCount} reviewers would run in ${rounds} configured round(s), above the ${COUNCIL_MAX_ACTIVE_REVIEWERS}-reviewer limit an adjudication can grade. Disable or park ${activeCount - COUNCIL_MAX_ACTIVE_REVIEWERS} member(s) in ${globalPath}, or pin them to a round above council.rounds.`,
		);
	}

	return {
		members: roster,
		rounds,
		advisor: {
			planner: parseAdvisorFlag(settings, "planner"),
			reviewers: parseAdvisorFlag(settings, "reviewers"),
			adjudicator: parseAdvisorFlag(settings, "adjudicator"),
		},
	};
}

/**
 * Whether a project-level `council.members` is configured. Council reads the
 * global roster only, so this is a fault of its own kind: it is repaired by
 * relocating the key, never by editing roster rows, which write to global.
 */
export function isProjectScopedCouncilRoster(settings: Settings): boolean {
	return settings.getRawSetting("council.members", "project").configured;
}
