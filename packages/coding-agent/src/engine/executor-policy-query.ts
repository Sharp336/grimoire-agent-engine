import { isRecord } from "@oh-my-pi/pi-utils";
import { type CandidateIdentity, type DispatchLimits, type DispatchRequirement, type EngineExecutionConfiguration,
	type EngineExecutionRoute, type RoutingLimits, EngineTargetError, humanSelectedCandidate } from "./contracts";
import { type ExecutorPolicyFacts, type PolicyCheck, type PolicyEvaluation, type PolicyScope, evaluateExecutorPolicy, executionPolicyFacts,
	executorPolicyRank, compareExecutorRanks } from "./executor-policy";
import { candidateIdentity, candidateRef, currentIdentity, previewRoutingCapacity } from "./routing-admission";
import { RuntimeTransaction } from "./runtime-records";
import type { RocksEngineStore } from "./rocks-runtime-store";
import type { ExecutorPolicyPreview } from "./runtime-protocol.mjs";
import { validateRuntimeValue } from "./runtime-protocol";

interface PublicRoute extends Omit<ExecutorPolicyFacts, "effort" | "service_tier" | "tier" | "billing_pools"> {
	efforts: EngineExecutionRoute["efforts"]; tier: Record<string, number | null>; pools: ExecutorPolicyFacts["billing_pools"];
}
interface PublicRoster { route_options: PublicRoute[]; policy_scopes: PolicyScope[]; routingLimits: RoutingLimits }
const reasons = (checks: readonly PolicyCheck[], status: PolicyCheck["status"]) => checks.filter(item => item.status === status)
	.map(({ code, message }) => ({ code, message }));
function available(evaluation: PolicyEvaluation): boolean { return evaluation.blocking_checks.length === 0 && evaluation.billing !== null; }

export async function executorPolicyPreview(store: RocksEngineStore, deviceId: string, params: Record<string, unknown>): Promise<ExecutorPolicyPreview> {
	if (typeof params.principalId !== "string" || !isRecord(params.roster) || typeof params.manual !== "boolean")
		throw new EngineTargetError("invalid_request", "Preview needs current principal-bound canonical facts");
	validateRuntimeValue("dispatchRequirement", params.requirement);
	validateRuntimeValue("dispatchLimits", params.limits);
	const requirement = params.requirement as DispatchRequirement, limits = params.limits as DispatchLimits;
	const roster = params.roster as unknown as PublicRoster;
	if (!Array.isArray(roster.route_options) || !Array.isArray(roster.policy_scopes) || roster.route_options.length > 512)
		throw new EngineTargetError("source_unavailable", "Complete bounded canonical roster facts are required");
	validateRuntimeValue("routingLimits", roster.routingLimits);
	const tuples: ExecutorPolicyFacts[] = [];
	for (const route of roster.route_options) {
		if (!Array.isArray(route.efforts) || !Array.isArray(route.observations) || !Array.isArray(route.pools))
			throw new EngineTargetError("source_unavailable", "Canonical route facts are incomplete");
		for (const effort of route.efforts) tuples.push({ ...route, effort, service_tier: requirement.service_tier,
			tier: route.tier[effort] ?? null, billing_pools: route.pools });
	}
	const capacity = await previewRoutingCapacity(new RuntimeTransaction(store.records, true), params.principalId, deviceId,
		roster.routingLimits, tuples.map(route => ({ scope_refs: roster.routingLimits.scopes.map(scope => scope.scope_ref),
			tier: route.tier, account_ref: route.account_ref, provider_id: route.provider_id, consultation: false })));
	const evaluate = (route: ExecutorPolicyFacts, index: number, request: DispatchRequirement, manual: boolean) => {
		const result = evaluateExecutorPolicy(route, request, manual, roster.policy_scopes, limits);
		for (const code of ["scope_concurrency", "tier_concurrency", "account_concurrency", "provider_concurrency"]) {
			result.checks.push({ code, status: capacity[index].includes(code) ? manual ? "ignored" : "blocked" : "pass",
				message: `Configured ${code.replaceAll("_", " ")}` });
		}
		result.blocking_checks = reasons(result.checks, "blocked");
		result.ignored_checks = reasons(result.checks, "ignored");
		return result;
	};
	const options: ExecutorPolicyPreview["options"] = [];
	const groups = new Map<string, Array<{ route: ExecutorPolicyFacts; result: PolicyEvaluation }>>();
	for (const [index, route] of tuples.entries()) {
		const hypothetical = { ...requirement, pin: { model_id: route.model_id, route_ref: route.route_ref,
			effort: route.effort, reason: "Picker preview only" } };
		const result = evaluate(route, index, hypothetical, true);
		options.push({ model_id: route.model_id, effort: route.effort, route_ref: route.route_ref,
			status: available(result) ? "available" : "unavailable", blocking_checks: result.blocking_checks, ignored_checks: result.ignored_checks });
		const key = `${route.model_id}\0${route.effort}`;
		const group = groups.get(key) ?? [];
		group.push({ route, result }); groups.set(key, group);
	}
	for (const group of groups.values()) {
		const ordered = group.map(item => ({ ...item, rank: executorPolicyRank(item.route, requirement, true, roster.policy_scopes) }))
			.sort((a, b) => compareExecutorRanks(a.rank, b.rank, a.route.route_ref, b.route.route_ref));
		const best = ordered.find(item => available(item.result)) ?? ordered[0];
		options.push({ model_id: best.route.model_id, effort: best.route.effort, route_ref: null,
			status: available(best.result) ? "available" : "unavailable", blocking_checks: best.result.blocking_checks,
			ignored_checks: best.result.ignored_checks });
	}
	const current = tuples.map((route, index) => ({ route, result: evaluate(route, index, requirement, params.manual as boolean),
		rank: executorPolicyRank(route, requirement, params.manual as boolean, roster.policy_scopes) }))
		.filter(({ route }) => !requirement.pin || route.model_id === requirement.pin.model_id && route.effort === requirement.pin.effort &&
			(requirement.pin.route_ref === null || route.route_ref === requirement.pin.route_ref))
		.sort((a, b) => compareExecutorRanks(a.rank, b.rank, a.route.route_ref, b.route.route_ref));
	const chosen = current.find(item => available(item.result)) ?? current.sort((a, b) => a.result.blocking_checks.length - b.result.blocking_checks.length)[0];
	const checks: PolicyCheck[] = chosen?.result.checks ?? [{ code: "route_available", status: "blocked", message: "No authorized route supports this selection" }];
	checks.push({ code: "authentication", status: "pass", message: "Authenticated principal-bound preview" },
		{ code: "record_acl", status: chosen ? "pass" : "unknown", message: "Only ACL-visible canonical route records are evaluated" },
		{ code: "fresh_integrity", status: "unknown", message: "Credential generation and record integrity are rechecked at send time" },
		{ code: "request_compatibility", status: "unknown", message: "Actual attachments and provider requests are checked at send time" },
		{ code: "human_receipt", status: params.manual ? "unknown" : "pass", message: params.manual
			? "Start must independently verify this human selection" : "Automatic execution receives no manual exception" });
	const response: ExecutorPolicyPreview = { schema: "artel.executor_policy_preview.v1", evaluated_at: new Date().toISOString(), options,
		selection: { mode: params.manual ? "manual" : "automatic", status: chosen && available(chosen.result) ? "available" : "unavailable", checks } };
	validateRuntimeValue("executorPolicyPreview", response);
	return response;
}

/** Called only by ClientHost after hosted ACL/credential/record attestation, before any provider effect. */
export async function executorPolicyAdmission(store: RocksEngineStore, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	if (typeof params.principalId !== "string" || !isRecord(params.identity) || !isRecord(params.verified) ||
		params.verified.allowed !== true || !isRecord(params.verified.route))
		throw new EngineTargetError("stale_target", "Current provider authority facts are missing");
	const identity = params.identity;
	if (typeof identity.attemptId !== "string") throw new EngineTargetError("invalid_request", "Attempt identity required");
	const attempt = await store.getAttempt(identity.attemptId);
	const command = attempt && await store.getStartConversationIdentity(attempt.command_id);
	const receipt = command && await store.runtimeCommand(command.commandId, { principalId: params.principalId });
	if (!attempt?.execution || !command?.serializedCommand || command.principalId !== params.principalId ||
		command.agentInstanceRef !== identity.agentInstanceRef || attempt.state !== "running" ||
		attempt.execution.dispatch_hash !== identity.dispatchHash || attempt.execution.executor_choice.execution_digest !== identity.executionDigest ||
		!receipt || !isRecord(receipt.lease) || receipt.lease.held !== true)
		throw new EngineTargetError("stale_target", "Provider request has no matching owned admitted Attempt and lease");
	const original = JSON.parse(command.serializedCommand) as { payload: { originReceiptId: string; executionConfiguration: EngineExecutionConfiguration } };
	if (original.payload.originReceiptId !== identity.originReceiptId)
		throw new EngineTargetError("stale_target", "Provider origin receipt differs");
	const config = original.payload.executionConfiguration, choice = attempt.execution.executor_choice;
	validateRuntimeValue("engineExecutionConfiguration", config);
	const selected = params.candidate === null ? currentIdentity(choice) : params.candidate;
	validateRuntimeValue("candidateIdentity", selected);
	const candidate = selected as CandidateIdentity;
	const captured = config.routes.routes.find(route => candidateRef(route) === candidateRef(candidate) && route.account_ref === candidate.account_ref);
	if (!captured || !choice.candidates.some(route => candidateRef(route) === candidateRef(candidate)) ||
		candidate.route_ref !== identity.routeRef || candidate.account_ref !== identity.providerAccountRef)
		throw new EngineTargetError("stale_target", "Provider route is outside the frozen Attempt");
	const live = params.verified.route;
	if (live.route_ref !== candidate.route_ref || live.account_ref !== candidate.account_ref || live.model_id !== candidate.model_id ||
		!isRecord(live.execution) || !Array.isArray(params.verified.observations) || !Array.isArray(params.verified.policy_scopes))
		throw new EngineTargetError("stale_target", "Fresh facts name another route");
	const facts: ExecutorPolicyFacts = { ...executionPolicyFacts(captured), credential_status: String(live.credential_status),
		observations: params.verified.observations as Record<string, unknown>[],
		billing_pools: live.pools as EngineExecutionRoute["billing_pools"], quota_windows: live.quota_windows as EngineExecutionRoute["quota_windows"],
		hard_quota_window_ids: live.hard_quota_window_ids as string[] };
	if (params.candidate === null && (params.verified.policy_scopes as PolicyScope[]).some(scope => scope.fallback?.same_model_other_pool === false))
		facts.billing_pools = facts.billing_pools.filter(pool => pool.pool_id === candidate.billing_pool_id);
	const manual = humanSelectedCandidate(choice, candidate);
	if (choice.selected.basis === "user" && !manual) throw new EngineTargetError("stale_target", "Human selection cannot authorize this route");
	const result = evaluateExecutorPolicy(facts, choice.effective_requirement, manual, params.verified.policy_scopes as PolicyScope[], config.dispatch.limits);
	const blocked = result.blocking_checks.filter(item => params.check_billing !== false || !["provider_quota", "quota_policy", "provider_availability"].includes(item.code));
	if (blocked.length) return { allowed: false, status: "provider_admission_denied", reason: blocked.map(item => item.code).join(", ") };
	if (params.check_billing === false) return { allowed: true };
	if (!result.billing) return { allowed: false, status: "billing_pools_exhausted" };
	const billing = { billing_pool_id: result.billing.billing_pool_id, billing_pool_basis: result.billing.billing_pool_basis };
	if (params.candidate === null && result.billing.billing_pool_id !== candidate.billing_pool_id) {
		return { allowed: false, status: "billing_pool_changed", billing: { from: candidateIdentity(candidate),
			from_execution_digest: choice.execution_digest, to: { ...candidateIdentity(candidate), ...billing }, reason: "billing_pool_exhausted" } };
	}
	return { allowed: true, billing };
}
