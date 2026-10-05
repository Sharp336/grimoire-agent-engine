import { describe, expect, it } from "bun:test";
import { evaluateExecutorPolicy, executionPolicyFacts, selectExecutorRoutes } from "../src/engine/executor-policy";
import { executorPolicyAdmission, executorPolicyPreview } from "../src/engine/executor-policy-query";
import { candidateIdentity } from "../src/engine/routing-admission";
import { active, admittedExecutionFixture, runtimeV1Fixture } from "./helpers/runtime-v1-rocks-fixture";
import { storageWorkerUnavailable } from "./helpers/storage-worker-fixture";

it("manual selection ignores configured preferences, grants and budget reserves but not scope or real exhaustion", () => {
	const execution = admittedExecutionFixture();
	const route = execution.config.routes.routes[0]!;
	Object.assign(route, { tier: 1, autoselect: "grant_only", family: "fixture", tags: [], latency_ms: 300 });
	Object.assign(route.execution, { trusted: false, supports_tools: false, input_modalities: ["text"], context_window: 100, max_output_tokens: 20 });
	route.billing_pools[0].reserve = 10;
	route.observations = [{ dimension: "pool", dimension_id: route.billing_pool_id, metric: "remaining", value: 5, unit: "usd" }];
	const requirement = { ...execution.config.dispatch.requirement, min_tier: 2, required: ["tools", "image"] as ("tools" | "image")[],
		min_effort: "high" as const, min_context: 101, min_output: 21, latency_ceiling_ms: 299,
		models: ["different"], required_tags: ["missing"], exclude: { models: [route.model_id], families: ["fixture"], agent_instances: [] } };
	const facts = executionPolicyFacts(route);
	const manual = evaluateExecutorPolicy(facts, requirement, true, [], { max_iterations: 1, timeout_seconds: 1 });
	expect(manual.blocking_checks).toEqual([]);
	expect(manual.ignored_checks.map(item => item.code).sort()).toEqual([
		"grant_only", "tier", "trusted_provider", "models", "min_effort", "required_tags", "min_context", "min_output", "latency", "tools", "image", "timeout", "iterations", "quota_policy",
	].sort());
	expect(evaluateExecutorPolicy(facts, requirement, false).blocking_checks.map(item => item.code)).toContain("trusted_provider");
	expect(evaluateExecutorPolicy(facts, requirement, true, [{ deny: [{ kind: "model", id: route.model_id }] }]).blocking_checks.map(item => item.code)).toEqual(["scope"]);
	expect(evaluateExecutorPolicy({ ...facts, observations: [{ dimension: "pool", dimension_id: route.billing_pool_id, metric: "remaining", value: 0 }] }, requirement, true)
		.blocking_checks.map(item => item.code)).toContain("provider_quota");
	expect(evaluateExecutorPolicy({ ...facts, observations: [], latency_ms: null }, requirement, true).checks.find(item => item.code === "latency")?.status).toBe("unknown");
});

it("distinguishes confirmed provider cap from a configured user budget", () => {
	const execution = admittedExecutionFixture();
	const route = execution.config.routes.routes[0]!;
	route.billing_pools[0].cap = { provider: 20, user: 10 };
	const requirement = execution.config.dispatch.requirement;
	const facts = executionPolicyFacts(route);
	const observed = (value: number) => ({ ...facts, observations: [
		{ dimension: "pool", dimension_id: route.billing_pool_id, metric: "used", value, unit: "requests" },
	] });
	const withinProvider = evaluateExecutorPolicy(observed(12), requirement, true);
	expect(withinProvider.blocking_checks).toEqual([]);
	expect(withinProvider.billing?.billing_pool_id).toBe(route.billing_pool_id);
	expect(withinProvider.ignored_checks.map(item => item.code)).toContain("quota_policy");
	const exhausted = evaluateExecutorPolicy(observed(20), requirement, true);
	expect(exhausted.blocking_checks.map(item => item.code)).toContain("provider_quota");
	expect(exhausted.billing).toBeNull();
});

it("admits unknown-tier automatic routes when no quality floor was requested", () => {
	const execution = admittedExecutionFixture();
	const route = execution.config.routes.routes[0]!;
	route.tier = null;
	execution.config.dispatch.requirement.min_tier = 0;
	const evaluated = evaluateExecutorPolicy(executionPolicyFacts(route), execution.config.dispatch.requirement, false);
	expect(evaluated.checks.find(item => item.code === "tier")?.status).toBe("pass");
	expect(selectExecutorRoutes(execution.config, null).routes.map(item => item.route_ref)).toEqual([route.route_ref]);
});

it.each(["fail", "reselect", "ask"] as const)("consultant unavailable pin obeys local %s without lowering the floor", mode => {
	const execution = admittedExecutionFixture(undefined, true);
	const [primary, alternate] = execution.config.routes.routes;
	primary.tier = 1; alternate.tier = 2;
	execution.config.dispatch.execution_kind = "consultation";
	execution.config.dispatch.requirement.min_tier = 2;
	execution.config.dispatch.requirement.pin = { model_id: primary.model_id, route_ref: primary.route_ref, effort: primary.effort, reason: "Pinned consultant" };
	execution.config.consultant_selection = { on_pin_unavailable: mode, pin: { route_ref: primary.route_ref, effort: primary.effort, reason: "Pinned consultant" } };
	const selected = selectExecutorRoutes(execution.config, null);
	expect(selected.requirement.min_tier).toBe(2);
	expect(selected.routes.map(route => route.route_ref)).toEqual(mode === "fail" ? [] : [alternate.route_ref]);
	expect(selected.askPin).toEqual(mode === "ask" ? execution.config.consultant_selection.pin : null);
	expect(execution.config.dispatch.requirement.pin?.route_ref).toBe(primary.route_ref);
});

// This exercises the actual Rust owner, not a mocked accounting/proof echo.
describe.skipIf(storageWorkerUnavailable)("local executor policy queries", () => {
	const { createStore } = runtimeV1Fixture();
	it("preview has exact and Any-provider options and manual availability agrees with local policy", async () => {
		const store = await createStore();
		const execution = admittedExecutionFixture();
		const route = execution.config.routes.routes[0]!;
		route.tier = 1; route.execution.trusted = false; route.autoselect = "grant_only";
		execution.config.routingLimits.accounts[route.account_ref] = 0;
		const facts = executionPolicyFacts(route);
		const roster = { route_options: [{ ...facts, efforts: [route.effort], tier: { [route.effort]: 1 }, pools: route.billing_pools }],
			policy_scopes: [], routingLimits: execution.config.routingLimits };
		const requirement = { ...execution.config.dispatch.requirement, min_tier: 2,
			pin: { model_id: route.model_id, route_ref: null, effort: route.effort, reason: "Explicit picker" } };
		const manual = await executorPolicyPreview(store, "device", { principalId: "owner", roster, requirement,
			limits: execution.config.dispatch.limits, manual: true });
		expect(manual.options.map(option => [option.route_ref, option.status])).toEqual([[route.route_ref, "available"], [null, "available"]]);
		expect(manual.selection.status).toBe("available");
		expect(manual.selection.checks.find(item => item.code === "account_concurrency")?.status).toBe("ignored");
		expect(evaluateExecutorPolicy(facts, requirement, true).blocking_checks).toEqual([]);
		const automatic = await executorPolicyPreview(store, "device", { principalId: "owner", roster, requirement: { ...requirement, pin: null },
			limits: execution.config.dispatch.limits, manual: false });
		expect(automatic.selection.status).toBe("unavailable");
		expect(automatic.selection.checks.find(item => item.code === "tier")?.status).toBe("blocked");
	});

	it("fresh provider gate requires owned durable proof and blocks physical exhaustion even for a manual Attempt", async () => {
		const store = await createStore();
		const execution = admittedExecutionFixture();
		const target = await active(store, "root", execution);
		const row = (await store.getAttempt(target.attemptId))!;
		const route = execution.config.routes.routes[0]!;
		const choice = row.execution!.executor_choice;
		const identity = { agentInstanceRef: target.bindingSnapshot!.agentInstanceRef, attemptId: target.attemptId,
			dispatchHash: target.dispatchHash, executionDigest: choice.execution_digest,
			routeRef: route.route_ref, providerAccountRef: route.account_ref, originReceiptId: `origin:${target.commandId}` };
		const verified = { allowed: true, route: { ...route, pools: route.billing_pools }, observations: [], policy_scopes: [] };
		const params = { principalId: "owner", identity, verified, candidate: null, check_billing: true };
		expect((await executorPolicyAdmission(store, params)).allowed).toBe(true);
		await expect(executorPolicyAdmission(store, { ...params, identity: { ...identity, dispatchHash: `sha256:${"f".repeat(64)}` } })).rejects.toMatchObject({ code: "stale_target" });
		await store.mutation(target.agentInstanceId, tx => tx.put("attempt", target.attemptId, {
			...row, execution: { ...row.execution!, executor_choice: { ...choice, selected: { ...choice.selected, basis: "user" },
				effective_requirement: { ...choice.effective_requirement, min_tier: 99, require_trusted_provider: true,
					pin: { model_id: route.model_id, route_ref: route.route_ref, effort: route.effort, reason: "Verified original choice" } } } },
		}));
		expect((await executorPolicyAdmission(store, params)).allowed).toBe(true);
		const exhausted = await executorPolicyAdmission(store, { ...params, verified: { ...verified,
			observations: [{ dimension: "pool", dimension_id: route.billing_pool_id, metric: "remaining", value: 0 }] } });
		expect(exhausted).toMatchObject({ allowed: false, status: "provider_admission_denied" });
		const providerCap = await executorPolicyAdmission(store, { ...params, verified: {
			...verified, route: { ...verified.route, pools: verified.route.pools.map(pool => ({
				...pool, cap: { provider: 20, user: 10 },
			})) }, observations: [{ dimension: "pool", dimension_id: route.billing_pool_id,
				metric: "used", value: 20, unit: "requests" }],
		} });
		expect(providerCap).toMatchObject({ allowed: false, status: "provider_admission_denied" });
		const foreign = { ...candidateIdentity(route), model_id: "another-model" };
		await expect(executorPolicyAdmission(store, { ...params, candidate: foreign })).rejects.toMatchObject({ code: "stale_target" });
	});
});
