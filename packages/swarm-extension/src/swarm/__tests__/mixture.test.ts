import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutorOptions, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { buildDependencyGraph, buildExecutionWaves } from "../dag";
import { PipelineController } from "../pipeline";
import {
	collectSwarmWarnings,
	type SwarmAgent,
	type SwarmDefinition,
	type SwarmMode,
	validateSwarmDefinition,
} from "../schema";
import { StateTracker } from "../state";

// ============================================================================
// Builders — assemble SwarmDefinition objects directly (mirrors parseSwarmYaml output)
// ============================================================================

function agent(name: string, overrides: Partial<SwarmAgent> = {}): SwarmAgent {
	return {
		name,
		role: `${name}-role`,
		task: `${name} task`,
		reportsTo: [],
		waitsFor: [],
		...overrides,
	};
}

function mixtureDef(agents: SwarmAgent[], mode: SwarmMode = "mixture", model?: string): SwarmDefinition {
	const map = new Map<string, SwarmAgent>();
	for (const a of agents) map.set(a.name, a);
	return {
		name: "test-mixture",
		workspace: "/tmp/ws",
		mode,
		targetCount: 1,
		model,
		agents: map,
		agentOrder: agents.map(a => a.name),
	};
}

/** A well-formed mixture topology: N proposers + one aggregator that waits_for all of them. */
function happyMixtureDef(proposerCount: number, opts: { proposerModel?: (i: number) => string } = {}): SwarmDefinition {
	const proposers = Array.from({ length: proposerCount }, (_, i) =>
		agent(`proposer${i + 1}`, opts.proposerModel ? { model: opts.proposerModel(i) } : {}),
	);
	const aggregator = agent("aggregator", { waitsFor: proposers.map(p => p.name) });
	return mixtureDef([...proposers, aggregator]);
}

function mockResult(over: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "x",
		agent: "x",
		agentSource: "project",
		task: "t",
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		...over,
	} as SingleResult;
}

// ============================================================================
// Validation — mixture shares the strict fan-in shape with vote
// ============================================================================

describe("validateSwarmDefinition — mixture mode", () => {
	it("accepts an aggregator + 2 proposers (no errors)", () => {
		expect(validateSwarmDefinition(happyMixtureDef(2))).toEqual([]);
	});

	it("accepts an aggregator + 3 proposers (no errors)", () => {
		expect(validateSwarmDefinition(happyMixtureDef(3))).toEqual([]);
	});

	it("rejects a missing aggregator (all agents are proposers, none waits_for)", () => {
		const def = mixtureDef([agent("p1"), agent("p2")]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("requires an aggregator"))).toBe(true);
	});

	it("rejects more than one aggregator", () => {
		const def = mixtureDef([
			agent("p1"),
			agent("p2"),
			agent("a1", { waitsFor: ["p1", "p2"] }),
			agent("a2", { waitsFor: ["p1", "p2"] }),
		]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("exactly one aggregator"))).toBe(true);
	});

	it("rejects fewer than 2 proposers", () => {
		const def = mixtureDef([agent("p1"), agent("aggregator", { waitsFor: ["p1"] })]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("at least 2 proposer"))).toBe(true);
	});

	it("rejects an aggregator that does not wait_for every proposer", () => {
		const def = mixtureDef([
			agent("p1"),
			agent("p2"),
			agent("p3"),
			agent("aggregator", { waitsFor: ["p1", "p2"] }), // misses p3
		]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("missing proposer 'p3'"))).toBe(true);
	});

	it("rejects a proposer that reports_to another proposer (would serialize wave 0)", () => {
		const def = mixtureDef([
			agent("p1", { reportsTo: ["p2"] }),
			agent("p2"),
			agent("aggregator", { waitsFor: ["p1", "p2"] }),
		]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("proposer 'p1' must not declare reports_to"))).toBe(true);
	});

	it("rejects an aggregator that reports_to a proposer (structural cycle)", () => {
		const def = mixtureDef([
			agent("p1"),
			agent("p2"),
			agent("aggregator", { waitsFor: ["p1", "p2"], reportsTo: ["p1"] }),
		]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("aggregator 'aggregator' must not declare reports_to"))).toBe(true);
	});
});

// ============================================================================
// Self-MoA guard (KTD-6) — heterogeneous proposers surface a non-fatal caveat
// ============================================================================

describe("collectSwarmWarnings — mixture Self-MoA guard", () => {
	it("emits no warning when proposers are homogeneous (all default to def.model)", () => {
		// Proposers carry no per-agent model, so they all inherit the swarm default.
		const def = happyMixtureDef(3, { proposerModel: undefined });
		def.model = "anthropic/claude-sonnet";
		expect(collectSwarmWarnings(def)).toEqual([]);
	});

	it("emits no warning when proposers explicitly share one model", () => {
		const def = happyMixtureDef(3, { proposerModel: () => "openai/gpt-x" });
		expect(collectSwarmWarnings(def)).toEqual([]);
	});

	it("emits a heterogeneous-proposer caveat when proposers use different models", () => {
		// Two distinct proposer models trips the Self-MoA caveat (KTD-6).
		const def = happyMixtureDef(2, { proposerModel: i => (i === 0 ? "model-a" : "model-b") });
		const warnings = collectSwarmWarnings(def);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("heterogeneous");
		expect(warnings[0]).toContain("Self-MoA");
		// The offending models are surfaced so the operator can see the mix.
		expect(warnings[0]).toContain("model-a");
		expect(warnings[0]).toContain("model-b");
	});

	it("excludes the aggregator from the homogeneity check (best-model aggregator is expected to differ)", () => {
		// Proposers share one model; the aggregator runs a different (best) model.
		// Per KTD-6 that is the recommended config and must NOT warn.
		const def = happyMixtureDef(2, { proposerModel: () => "proposer-model" });
		def.agents.get("aggregator")!.model = "best-aggregator-model";
		expect(collectSwarmWarnings(def)).toEqual([]);
	});

	it("does not warn for non-mixture modes", () => {
		const def = happyMixtureDef(2, { proposerModel: i => (i === 0 ? "model-a" : "model-b") });
		def.mode = "vote";
		expect(collectSwarmWarnings(def)).toEqual([]);
	});
});

// ============================================================================
// DAG — mixture reuses the vote wave shape (no new DAG primitive, KTD-5)
// ============================================================================

describe("mixture mode DAG", () => {
	it("places proposers in wave 0 and the aggregator in wave 1", () => {
		const def = happyMixtureDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		expect(waves).toHaveLength(2);
		expect(waves[0].sort()).toEqual(["proposer1", "proposer2", "proposer3"]);
		expect(waves[1]).toEqual(["aggregator"]);
	});

	it("gives proposers no implicit chain (all proposers share wave 0)", () => {
		const def = happyMixtureDef(3);
		const deps = buildDependencyGraph(def);
		expect(deps.get("proposer1")!.size).toBe(0);
		expect(deps.get("proposer2")!.size).toBe(0);
		expect(deps.get("proposer3")!.size).toBe(0);
		expect([...deps.get("aggregator")!].sort()).toEqual(["proposer1", "proposer2", "proposer3"]);
	});
});

// ============================================================================
// Pipeline — the aggregator SYNTHESIZES (mixture reduce), distinct from vote JUDGE
// ============================================================================

describe("PipelineController — mixture reduce", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-mixture-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it("fans out proposers and injects every proposal into the aggregator, instructing synthesis", async () => {
		const spy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async (opts: ExecutorOptions) => {
			const name = opts.agent.name;
			return mockResult({ agent: name, output: `PROPOSAL_FROM_${name}` });
		});

		const def = happyMixtureDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const result = await new PipelineController(def, waves, stateTracker).run({ workspace });

		expect(result.status).toBe("completed");
		// 3 proposers + 1 aggregator = 4 subprocess invocations.
		expect(spy).toHaveBeenCalledTimes(4);

		const aggCall = spy.mock.calls.find(c => c[0].agent.name === "aggregator");
		expect(aggCall).toBeDefined();
		const aggPrompt = aggCall![0].agent.systemPrompt ?? "";
		// Every proposer output reaches the aggregator's context.
		expect(aggPrompt).toContain("PROPOSAL_FROM_proposer1");
		expect(aggPrompt).toContain("PROPOSAL_FROM_proposer2");
		expect(aggPrompt).toContain("PROPOSAL_FROM_proposer3");
		// The aggregator is told to SYNTHESIZE — the mixture reduce, not vote's JUDGE.
		expect(aggPrompt).toContain("AGGREGATOR");
		expect(aggPrompt).toContain("SYNTHESIZE");
		expect(aggPrompt).toContain("mixture-of-agents");
		// Mixture must NOT prompt the vote JUDGE/consensus reduce.
		expect(aggPrompt).not.toContain("JUDGE");
		expect(aggPrompt.toLowerCase()).not.toContain("consensus");
	});

	it("does not inject proposals into the proposers themselves", async () => {
		const spy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockImplementation(async (opts: ExecutorOptions) =>
				mockResult({ agent: opts.agent.name, output: `PROPOSAL_FROM_${opts.agent.name}` }),
			);

		const def = happyMixtureDef(2);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		await new PipelineController(def, waves, stateTracker).run({ workspace });

		const proposerCall = spy.mock.calls.find(c => c[0].agent.name === "proposer1");
		expect(proposerCall).toBeDefined();
		const proposerPrompt = proposerCall![0].agent.systemPrompt ?? "";
		expect(proposerPrompt).not.toContain("AGGREGATOR");
		expect(proposerPrompt).not.toContain("PROPOSAL_FROM_proposer2");
	});

	it("single proposer degenerates to a passthrough (aggregator synthesizes the one proposal)", async () => {
		// A 1-proposer mixture is structurally valid only as a direct construction (the
		// validator recommends >=2); here we exercise the runtime reduce to show it does
		// not crash and the lone proposal still reaches the aggregator unchanged.
		const def = mixtureDef([agent("p1"), agent("aggregator", { waitsFor: ["p1"] })]);
		const spy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockImplementation(async (opts: ExecutorOptions) =>
				mockResult({ agent: opts.agent.name, output: `PROPOSAL_FROM_${opts.agent.name}` }),
			);

		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const result = await new PipelineController(def, waves, stateTracker).run({ workspace });

		expect(result.status).toBe("completed");
		expect(spy).toHaveBeenCalledTimes(2);
		const aggCall = spy.mock.calls.find(c => c[0].agent.name === "aggregator")!;
		const aggPrompt = aggCall[0].agent.systemPrompt ?? "";
		// The single proposal is present; with one proposal "synthesis" degenerates to
		// passing the lone answer through, but the aggregator still runs the reduce.
		expect(aggPrompt).toContain("PROPOSAL_FROM_p1");
		expect(aggPrompt).toContain("SYNTHESIZE");
	});

	it("still synthesizes when one proposer fails (failure surfaced to the aggregator)", async () => {
		const spy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async (opts: ExecutorOptions) => {
			const name = opts.agent.name;
			if (name === "proposer2") {
				return mockResult({ agent: name, exitCode: 1, output: "", error: "boom" });
			}
			return mockResult({ agent: name, output: `PROPOSAL_FROM_${name}` });
		});

		const def = happyMixtureDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const result = await new PipelineController(def, waves, stateTracker).run({ workspace });

		const aggCall = spy.mock.calls.find(c => c[0].agent.name === "aggregator")!;
		const aggPrompt = aggCall[0].agent.systemPrompt ?? "";
		expect(aggPrompt).toContain("PROPOSAL_FROM_proposer1");
		expect(aggPrompt).toContain("PROPOSAL_FROM_proposer3");
		// The failed proposer is surfaced rather than silently dropped.
		expect(aggPrompt).toContain("proposer failed");
		expect(result.errors.some(e => e.includes("proposer2"))).toBe(true);
	});

	it("downgrades the aggregator instruction when every proposer fails (no fabricated synthesis)", async () => {
		const spy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async (opts: ExecutorOptions) => {
			const name = opts.agent.name;
			if (name === "aggregator") {
				return mockResult({ agent: name, output: "report" });
			}
			return mockResult({ agent: name, exitCode: 1, output: "", error: `boom-${name}` });
		});

		const def = happyMixtureDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const result = await new PipelineController(def, waves, stateTracker).run({ workspace });

		expect(result.status).toBe("failed");
		const aggCall = spy.mock.calls.find(c => c[0].agent.name === "aggregator")!;
		const aggPrompt = aggCall[0].agent.systemPrompt ?? "";
		// All proposers failed: the aggregator must be told NOT to fabricate a synthesis.
		expect(aggPrompt).toContain("EVERY proposer failed");
		expect(aggPrompt).toContain("Do NOT fabricate a");
		// And must NOT carry the synthesis instruction.
		expect(aggPrompt).not.toContain("combines the complementary strengths");
	});
});
