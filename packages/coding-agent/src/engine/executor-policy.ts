import { type BillingPool, type DispatchLimits, type DispatchRequirement, type EngineExecutionConfiguration, type EngineExecutionRoute,
	type HumanSelectionProof, type QuotaWindow, type ScopeLimits, humanSelectionMatches } from "./contracts";
import { runtimeProtocol } from "./runtime-protocol.mjs";

export type PolicyCheck = { code: string; status: "pass" | "ignored" | "blocked" | "unknown"; message: string };
export type PolicyReason = Pick<PolicyCheck, "code" | "message">;
export type PolicyScope = Pick<ScopeLimits, "allow" | "deny" | "grants" | "fallback" | "tools_deny" | "max_children" | "max_depth" | "order"> & { ref?: string };
export interface ExecutorPolicyFacts {
	model_id: string; route_ref: string; account_ref: string; provider_id: string;
	effort: EngineExecutionRoute["effort"]; service_tier: EngineExecutionRoute["service_tier"];
	tier: number | null; autoselect: "auto" | "manual" | "grant_only";
	latency_ms: number | null; family: string | null; tags: readonly string[];
	trusted: boolean; supports_tools: boolean; input_modalities: readonly string[];
	context_window: number | null; max_output_tokens: number | null;
	credential_status: string; service_tiers: readonly string[];
	api: string; efforts: readonly EngineExecutionRoute["effort"][];
	billing_pools: readonly BillingPool[]; quota_windows: readonly QuotaWindow[];
	hard_quota_window_ids: readonly string[]; observations: readonly Record<string, unknown>[];
}
export interface PolicyEvaluation {
	checks: PolicyCheck[]; ignored_checks: PolicyReason[]; blocking_checks: PolicyReason[];
	billing: { billing_pool_id: string; billing_pool_basis: "expected" | "observed"; quota_window_ids: string[] } | null;
}
const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const remainingMetrics: Record<string, true> = { remaining: true, quota_remaining: true, package_remaining: true, cash_balance_usd: true };
const usedMetrics: Record<string, true> = { used: true, aggregate_spend_usd: true, request_count: true };
// Bundled canonical schema, not caller-supplied policy or an independent API catalog.
const providerApiSchema = runtimeProtocol.$defs.providerApi as { enum: string[] };
const supportedApis = providerApiSchema.enum;

export function executionPolicyFacts(route: EngineExecutionRoute): ExecutorPolicyFacts {
	return { model_id: route.model_id, route_ref: route.route_ref, account_ref: route.account_ref,
		provider_id: route.provider_id, effort: route.effort, service_tier: route.service_tier,
		tier: route.tier, autoselect: route.autoselect, latency_ms: route.latency_ms, family: route.family,
		tags: route.tags, trusted: route.execution.trusted, supports_tools: route.execution.supports_tools,
		input_modalities: route.execution.input_modalities, context_window: route.execution.context_window,
		max_output_tokens: route.execution.max_output_tokens, credential_status: route.credential_status,
		api: route.execution.api, efforts: route.efforts,
		service_tiers: route.service_tiers, billing_pools: route.billing_pools, quota_windows: route.quota_windows,
		hard_quota_window_ids: route.hard_quota_window_ids, observations: route.observations };
}

function targetMatches(target: NonNullable<PolicyScope["deny"]>[number], route: ExecutorPolicyFacts): boolean {
	const identity = target.kind === "provider" ? route.provider_id : target.kind === "account" ? route.account_ref
		: target.kind === "route" ? route.route_ref : route.model_id;
	return target.id === identity && (target.kind !== "model_effort" || target.effort === route.effort);
}

/** Single policy implementation for Start, retained Attempts, live provider gates and picker preview. */
export function evaluateExecutorPolicy(facts: ExecutorPolicyFacts, requirement: DispatchRequirement,
	manual: boolean, scopes: readonly PolicyScope[] = [], limits?: DispatchLimits, now = Date.now()): PolicyEvaluation {
	const checks: PolicyCheck[] = [];
	const add = (code: string, message: string, failed: boolean, automatic = false, unknown = false) =>
		checks.push({ code, message, status: unknown ? "unknown" : failed ? automatic && manual ? "ignored" : "blocked" : "pass" });
	const pin = requirement.pin;
	add("pin", "Exact model, provider and effort selection", pin !== null && (facts.model_id !== pin.model_id ||
		facts.effort !== pin.effort || pin.route_ref !== null && facts.route_ref !== pin.route_ref));
	add("scope", "Scope allow/deny rules", scopes.some(scope => scope.deny?.some(target => targetMatches(target, facts)) ||
		scope.allow !== undefined && !scope.allow.some(target => targetMatches(target, facts))));
	add("credential", "Current credential readiness", facts.credential_status !== "ready");
	add("api", "Supported provider API", !supportedApis.includes(facts.api));
	add("effort", "Supported exact effort", !facts.efforts.includes(facts.effort));
	add("service_tier", "Supported service tier", !facts.service_tiers.includes(facts.service_tier));
	add("tools_deny", "Scope-denied tools are enforced on each actual invocation", false, false,
		scopes.some(scope => (scope.tools_deny?.length ?? 0) > 0));
	add("spawn_rights", "Child launch depth and count are enforced on each actual spawn", false, false,
		scopes.some(scope => scope.max_depth !== undefined || scope.max_children !== undefined));
	add("autoselect", "Automatic route selection preference", facts.autoselect === "manual", true);
	add("grant_only", "Configured grant-only restriction", facts.autoselect === "grant_only" &&
		!scopes.some(scope => scope.grants?.includes(facts.model_id)), true);
	add("tier", "Automatic minimum model tier",
		facts.tier === null ? requirement.min_tier > 0 : facts.tier < requirement.min_tier, true);
	add("trusted_provider", "Automatic trusted-provider requirement", requirement.require_trusted_provider && !facts.trusted, true);
	add("models", "Automatic model and family preferences", requirement.models !== null && !requirement.models.includes(facts.model_id) ||
		requirement.exclude.models.includes(facts.model_id) || facts.family !== null && requirement.exclude.families.includes(facts.family), true);
	add("min_effort", "Automatic minimum effort", requirement.min_effort !== null &&
		effortOrder.indexOf(facts.effort) < effortOrder.indexOf(requirement.min_effort), true);
	add("required_tags", "Automatic required tags", requirement.required_tags.some(tag => !facts.tags.includes(tag)), true);
	add("preferred_tags", "Preferred tags are ranking hints", manual && requirement.preferred_tags.some(tag => !facts.tags.includes(tag)), true);
	add("min_context", "Automatic minimum context", requirement.min_context !== null && facts.context_window !== null &&
		facts.context_window < requirement.min_context, true, requirement.min_context !== null && facts.context_window === null);
	add("min_output", "Automatic minimum output", requirement.min_output !== null && facts.max_output_tokens !== null &&
		facts.max_output_tokens < requirement.min_output, true, requirement.min_output !== null && facts.max_output_tokens === null);
	add("latency", "Automatic latency ceiling", requirement.latency_ceiling_ms !== null && facts.latency_ms !== null &&
		facts.latency_ms > requirement.latency_ceiling_ms, true, requirement.latency_ceiling_ms !== null && facts.latency_ms === null);
	add("tools", "Automatic tool-capability filter", requirement.required.includes("tools") && !facts.supports_tools, true);
	add("image", "Automatic image-capability filter", requirement.required.includes("image") && !facts.input_modalities.includes("image"), true);
	add("timeout", "Configured execution time ceiling", manual && limits?.timeout_seconds != null, true);
	add("iterations", "Configured iteration ceiling", manual && limits?.max_iterations != null, true);
	const observations = facts.observations.filter(item => typeof item.valid_until !== "string" || Date.parse(item.valid_until) > now);
	const routeFacts = observations.filter(item => item.dimension === "route" && item.dimension_id === facts.route_ref);
	add("provider_availability", "Current provider availability", routeFacts.some(item =>
		item.metric === "health" && item.value === "unavailable" || item.metric === "hard_denial" && (item.value === 1 || item.value === true) ||
		item.metric === "cooldown_until" && typeof item.value === "string" && Date.parse(item.value) > now), false, routeFacts.length === 0);
	const resource = (dimension: string, id: string, reserve: number, limit: number | null,
		fractionReserve: number | null, providerLimit = limit) => {
		let actual = false, internal = limit !== null && limit <= reserve, observed = false;
		for (const item of observations) {
			if (item.dimension !== dimension || item.dimension_id !== id) continue;
			observed = true;
			if ((item.metric === "exhausted" || item.metric === "hard_denial") && (item.value === true || item.value === 1)) actual = true;
			if (typeof item.value !== "number" || !Number.isFinite(item.value)) continue;
			const metric = String(item.metric), fractional = item.unit === "fraction";
			const floor = fractional && fractionReserve !== null ? fractionReserve : reserve;
			const ceiling = fractional && fractionReserve !== null ? 1 : limit;
			if (remainingMetrics[metric]) { actual ||= item.value <= 0; internal ||= item.value <= floor; }
			if (usedMetrics[metric]) {
				actual ||= fractional ? item.value >= 1 : providerLimit !== null && item.value >= providerLimit;
				internal ||= ceiling !== null && item.value >= ceiling - floor;
			}
		}
		return { actual, internal, observed };
	};
	const window = (id: string) => {
		const value = facts.quota_windows.find(item => item.window_id === id);
		return value ? resource("quota_window", id, value.limit * value.reserve_fraction, value.limit, value.reserve_fraction)
			: { actual: false, internal: false, observed: false };
	};
	const hard = facts.hard_quota_window_ids.map(window);
	let billing: PolicyEvaluation["billing"] = null;
	let actualExhausted = hard.some(item => item.actual), internalExhausted = hard.some(item => item.internal), observedQuota = hard.some(item => item.observed);
	let selectedInternal = false, physicalPoolAvailable = false;
	for (const pool of facts.billing_pools) {
		const cap = pool.cap, known = [cap?.provider, cap?.user].filter((item): item is number => item != null);
		const ceiling = known.length ? Math.min(...known) : null;
		const fraction = pool.kind === "window" || pool.kind === "corp_quota";
		const own = resource("pool", pool.pool_id, fraction ? pool.reserve * (ceiling ?? 0) : pool.reserve,
			ceiling, fraction ? pool.reserve : null, cap?.provider ?? null);
		const windows = pool.quota_windows.map(window);
		const actual = actualExhausted || own.actual || windows.some(item => item.actual);
		const internal = internalExhausted || own.internal || windows.some(item => item.internal);
		observedQuota ||= own.observed || windows.some(item => item.observed);
		physicalPoolAvailable ||= !actual;
		if (actual || !manual && internal) continue;
		selectedInternal = internal;
		let reported: Record<string, unknown> | undefined, reportedAt = -Infinity;
		for (const item of routeFacts) {
			const at = typeof item.observed_at === "string" ? Date.parse(item.observed_at) : -Infinity;
			if (item.metric === "billing_pool_id" && at >= reportedAt) { reported = item; reportedAt = at; }
		}
		billing = { billing_pool_id: pool.pool_id, billing_pool_basis: reported?.value === pool.pool_id ? "observed" : "expected",
			quota_window_ids: [...new Set([...facts.hard_quota_window_ids, ...pool.quota_windows])] };
		break;
	}
	if (!billing) {
		actualExhausted ||= !physicalPoolAvailable;
		internalExhausted = !actualExhausted;
	}
	add("provider_quota", "Confirmed provider exhaustion", actualExhausted, false, !actualExhausted && !observedQuota);
	add("quota_policy", "Internal quota reserve and budget ceilings", billing ? selectedInternal : internalExhausted, true);
	return { checks, ignored_checks: checks.filter(item => item.status === "ignored").map(({ code, message }) => ({ code, message })),
		blocking_checks: checks.filter(item => item.status === "blocked").map(({ code, message }) => ({ code, message })), billing };
}

export function executorOrderMatch(facts: ExecutorPolicyFacts, requirement: DispatchRequirement, manual: boolean,
	scopes: readonly PolicyScope[]): EngineExecutionRoute["order_match"] {
	if (manual) return null;
	for (let index = scopes.length - 1; index >= 0; index--) {
		const scope = scopes[index];
		if (scope.order === undefined) continue;
		const match = scope.order.findIndex(item => item.for_tags.every(tag =>
			requirement.required_tags.includes(tag) || requirement.preferred_tags.includes(tag)) && targetMatches(item.target, facts));
		return match < 0 ? null : { scope_ref: scope.ref ?? "global", index: match, for_tags: scope.order[match].for_tags };
	}
	return null;
}

/** Measured tie order is shared with preview; absent measurements never become fabricated zeroes. */
export function executorPolicyRank(facts: ExecutorPolicyFacts, requirement: DispatchRequirement, manual: boolean,
	scopes: readonly PolicyScope[]): readonly number[] {
	let load: number | null = null, health = 2, loadAt = -Infinity, healthAt = -Infinity;
	for (const item of facts.observations) {
		if (item.dimension !== "route" || item.dimension_id !== facts.route_ref) continue;
		if (typeof item.valid_until === "string" && Date.parse(item.valid_until) <= Date.now()) continue;
		const at = typeof item.observed_at === "string" ? Date.parse(item.observed_at) : -Infinity;
		if (item.metric === "load" && typeof item.value === "number" && at >= loadAt) { load = item.value; loadAt = at; }
		if (item.metric === "health" && at >= healthAt) { health = item.value === "healthy" ? 0 : item.value === "degraded" ? 1 : 2; healthAt = at; }
	}
	return [executorOrderMatch(facts, requirement, manual, scopes)?.index ?? Number.MAX_SAFE_INTEGER,
		load === null ? 1 : 0, load ?? 0, health, effortOrder.indexOf(facts.effort)];
}

export function compareExecutorRanks(left: readonly number[], right: readonly number[], leftRoute: string, rightRoute: string): number {
	for (let index = 0; index < left.length - 1; index++) if (left[index] !== right[index]) return left[index] - right[index];
	return leftRoute.localeCompare(rightRoute) || left[left.length - 1] - right[right.length - 1];
}

/** No mutation of signed Dispatch/facts: consultant reselection changes only the effective local requirement. */
export function selectExecutorRoutes(config: EngineExecutionConfiguration, human: HumanSelectionProof | null) {
	const select = (requirement: DispatchRequirement, pin = config.consultant_selection?.pin) => {
		const ranked: Array<{ route: EngineExecutionRoute; rank: readonly number[] }> = [];
		for (const route of config.routes.routes) {
			if (human && !humanSelectionMatches(human, route)) continue;
			if (pin && (route.route_ref !== pin.route_ref || route.effort !== pin.effort)) continue;
			const facts = executionPolicyFacts(route);
			const evaluated = evaluateExecutorPolicy(facts, requirement, human !== null,
				config.policy_scopes, config.dispatch.limits);
			if (evaluated.blocking_checks.length || !evaluated.billing) continue;
			ranked.push({ route: { ...route, ...evaluated.billing,
				order_match: executorOrderMatch(facts, requirement, human !== null, config.policy_scopes) },
				rank: executorPolicyRank(facts, requirement, human !== null, config.policy_scopes) });
		}
		return ranked.sort((a, b) => compareExecutorRanks(a.rank, b.rank, a.route.route_ref, b.route.route_ref)).map(item => item.route);
	};
	let requirement = config.dispatch.requirement;
	let routes = select(requirement);
	const consultant = config.dispatch.execution_kind === "consultation" ? config.consultant_selection : null;
	let askPin: NonNullable<EngineExecutionConfiguration["consultant_selection"]>["pin"] = null;
	if (!routes.length && consultant?.pin && consultant.on_pin_unavailable !== "fail") {
		requirement = { ...requirement, pin: null };
		routes = select(requirement, null);
		if (routes.length && consultant.on_pin_unavailable === "ask") askPin = consultant.pin;
	}
	return { routes, requirement, askPin };
}
