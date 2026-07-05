import type { NikoflowPhase, NikoflowRole } from "./state";
import { PHASE_ROLE } from "./state";

export interface ResolvedRoleModel {
	model?: string | null;
	provider?: string | null;
}

export type RoleModelResolver = (role: NikoflowRole) => ResolvedRoleModel | string | null | undefined;

export interface NikoflowResolvedRoles {
	plan: string;
	default: string | null;
	advisor: string | null;
}

export function roleForPhase(phase: NikoflowPhase): NikoflowRole {
	return PHASE_ROLE[phase];
}

function modelKey(value: ResolvedRoleModel | string | null | undefined): string | null {
	if (typeof value === "string") return value || null;
	if (!value?.model) return null;
	return value.provider ? `${value.provider}/${value.model}` : value.model;
}

export function assertNikoflowRoleRails(resolve: RoleModelResolver): NikoflowResolvedRoles {
	const plan = modelKey(resolve("plan"));
	const defaultRole = modelKey(resolve("default"));
	const advisor = modelKey(resolve("advisor"));

	if (!plan) {
		throw new Error("Nikoflow requires modelRoles.plan to resolve to a configured model.");
	}
	if (defaultRole && plan === defaultRole) {
		throw new Error("Nikoflow requires modelRoles.plan to differ from modelRoles.default.");
	}

	return { plan, default: defaultRole, advisor };
}

export function shouldReassertNikoflowRoleRails(event: string | { type?: string; event?: string }): boolean {
	if (typeof event === "string") return event === "retry_fallback_applied";
	return event.type === "retry_fallback_applied" || event.event === "retry_fallback_applied";
}

export function reassertNikoflowRoleRails(
	event: string | { type?: string; event?: string },
	resolve: RoleModelResolver,
): NikoflowResolvedRoles | null {
	return shouldReassertNikoflowRoleRails(event) ? assertNikoflowRoleRails(resolve) : null;
}
