import { expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { CandidateIdentity, ChoiceTransition, ExecutorChoice, InstructionRule } from "../src/engine/contracts";
import { candidateIdentity, executorRuleReplay, l1For, renderRules, ruleDelta } from "../src/engine/routing-admission";
import { projectExecutorRulesContext } from "../src/engine/runtime";

const hash = `sha256:${"a".repeat(64)}`;
const a: CandidateIdentity = { model_id: "model-a", route_ref: "gctx:aaaaaaaaaaaaaaaa", account_ref: "gctx:cccccccccccccccc",
	effort: "high", service_tier: "standard", billing_pool_id: "included", billing_pool_basis: "expected" };
const b: CandidateIdentity = { ...a, model_id: "model-b", route_ref: "gctx:bbbbbbbbbbbbbbbb" };
const pool: CandidateIdentity = { ...b, billing_pool_id: "paid", billing_pool_basis: "observed" };
const rules: InstructionRule[] = [
	{ ref: "gctx:dddddddddddddddd", revision: 1, content_hash: hash, content: "generic-first", route_refs: null },
	{ ref: "gctx:eeeeeeeeeeeeeeee", revision: 2, content_hash: hash, content: "route-a-only", route_refs: [a.route_ref] },
	{ ref: "gctx:ffffffffffffffff", revision: 3, content_hash: hash, content: "route-b-only", route_refs: [b.route_ref] },
	{ ref: "gctx:gggggggggggggggg", revision: 4, content_hash: hash, content: "scope-last", route_refs: null },
];
const first: ChoiceTransition = { seq: 1, event_id: "original-route-event", from: a, to: b, reason: "route_fallback",
	at: "2026-09-30T00:00:00Z", lease_revision: 2, from_execution_digest: hash, to_execution_digest: hash };

it("replays deltas from the admitted baseline using original event IDs and exact accumulated provenance", () => {
	const baseline = l1For({ rules }, a);
	expect(baseline.map(rule => rule.content)).toEqual(["generic-first", "route-a-only", "scope-last"]);
	const delta = ruleDelta({ rules }, baseline, b);
	expect(delta).toEqual([rules[2]]);
	expect(ruleDelta({ rules }, [...baseline, ...delta], pool)).toEqual([]);
	const transitions: ChoiceTransition[] = [first,
		{ ...first, seq: 2, event_id: "original-pool-event", from: b, to: pool, reason: "billing_pool_observed" },
		{ ...first, seq: 3, event_id: "original-return-event", from: pool, to: a }];
	const choice: Pick<ExecutorChoice, "selected" | "rules" | "transitions"> = {
		selected: { ...a, basis: "rank", order_match: null }, transitions,
		rules: [...baseline, ...delta].map(({ ref, revision, content_hash }) => ({ ref, revision, content_hash })),
	};
	expect(executorRuleReplay({ rules }, choice)).toEqual([{ eventId: first.event_id, route: b, rules: delta }]);
	for (const changed of [
		{ ...choice, rules: choice.rules.slice(0, -1) },
		{ ...choice, rules: choice.rules.map((rule, index) => index === 0 ? { ...rule, revision: 9 } : rule) },
		{ ...choice, transitions: [{ ...first, from: b }] },
		{ ...choice, transitions: [first, { ...transitions[1], event_id: first.event_id }] },
	]) expect(() => executorRuleReplay({ rules }, changed)).toThrow();
	// Stable prompt stays the admitted ordered baseline; route instructions remain explicitly scoped.
	expect(renderRules(baseline)).toContain(`applies-only-to-route-refs="${a.route_ref}"`);
	expect(renderRules(baseline)).not.toContain("route-b-only");
	expect(candidateIdentity(choice.selected)).toEqual(a);
});

it("replaces all raw rule messages after compaction with current ordered L1 without changing audit history", () => {
	const old = createCustomMessage("executor-rules", "old-attempt-rule", false,
		{ attemptId: "previous", eventId: "old" }, "2026-09-30T00:00:00Z", "agent");
	const before = createCustomMessage("executor-rules", "route-a-only", false,
		{ attemptId: "current", eventId: "first" }, "2026-09-30T00:00:01Z", "agent");
	const after = createCustomMessage("executor-rules", "route-b-only", false,
		{ attemptId: "current", eventId: first.event_id }, "2026-09-30T00:00:03Z", "agent");
	const audit = createCustomMessage("route-audit", "unchanged audit", true, {}, "2026-09-30T00:00:04Z", "agent");
	const summary: AgentMessage = { role: "compactionSummary", summary: "historical route-a-only", tokensBefore: 300, timestamp: 2 };
	const conversation: AgentMessage = { role: "user", content: "continue", timestamp: 5 };
	const messages = [old, before, summary, after, audit, conversation];
	const retained = structuredClone(messages);
	const current = { attemptId: "current", rules: l1For({ rules }, b), compactionEntryId: () => "summary-entry" };
	const projected = projectExecutorRulesContext(messages, current);
	expect(projected.map(message => message.role)).toEqual(["compactionSummary", "custom", "custom", "user"]);
	expect(projected[0]).toBe(summary);
	expect(projected[2]).toBe(audit);
	expect(projected[3]).toBe(conversation);
	const ruleMessage = projected[1];
	expect(ruleMessage).toMatchObject({ role: "custom", customType: "executor-rules",
		details: { attemptId: "current", eventId: "compaction:summary-entry" } });
	if (ruleMessage.role !== "custom") throw new Error("missing current rule projection");
	const content = String(ruleMessage.content);
	expect(content).not.toContain("route-a-only");
	expect(content.indexOf("generic-first")).toBeLessThan(content.indexOf("route-b-only"));
	expect(content.indexOf("route-b-only")).toBeLessThan(content.indexOf("scope-last"));
	expect(messages).toEqual(retained);
	expect(projectExecutorRulesContext(projected, current)).toEqual(projected);
	expect(projectExecutorRulesContext([old, before, audit, after], current)).toEqual([before, audit, after]);
	expect(projectExecutorRulesContext(messages, { ...current, rules: [] })).toHaveLength(4);
	expect(() => projectExecutorRulesContext(messages, { ...current, compactionEntryId: () => null })).toThrow();
});
