import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutorOptions, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { buildDependencyGraph, buildExecutionWaves, findVoteAggregator } from "../dag";
import { PipelineController } from "../pipeline";
import { type SwarmAgent, type SwarmDefinition, type SwarmMode, validateSwarmDefinition } from "../schema";
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

function voteDef(agents: SwarmAgent[], mode: SwarmMode = "vote"): SwarmDefinition {
	const map = new Map<string, SwarmAgent>();
	for (const a of agents) map.set(a.name, a);
	return {
		name: "test-vote",
		workspace: "/tmp/ws",
		mode,
		targetCount: 1,
		agents: map,
		agentOrder: agents.map(a => a.name),
	};
}

/** A well-formed vote topology: N voters + one judge that waits_for all of them. */
function happyVoteDef(voterCount: number): SwarmDefinition {
	const voters = Array.from({ length: voterCount }, (_, i) => agent(`voter${i + 1}`));
	const judge = agent("judge", { waitsFor: voters.map(v => v.name) });
	return voteDef([...voters, judge]);
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
// Validation
// ============================================================================

describe("validateSwarmDefinition — vote mode", () => {
	it("accepts a judge + 2 voters (no errors)", () => {
		expect(validateSwarmDefinition(happyVoteDef(2))).toEqual([]);
	});

	it("accepts a judge + 3 voters (no errors)", () => {
		expect(validateSwarmDefinition(happyVoteDef(3))).toEqual([]);
	});

	it("rejects a missing aggregator (all agents are voters, none waits_for)", () => {
		const def = voteDef([agent("v1"), agent("v2")]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("judge/aggregator"))).toBe(true);
	});

	it("rejects more than one aggregator", () => {
		const def = voteDef([
			agent("v1"),
			agent("v2"),
			agent("j1", { waitsFor: ["v1", "v2"] }),
			agent("j2", { waitsFor: ["v1", "v2"] }),
		]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("exactly one judge/aggregator"))).toBe(true);
	});

	it("rejects fewer than 2 voters", () => {
		const def = voteDef([agent("v1"), agent("judge", { waitsFor: ["v1"] })]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("at least 2 voter"))).toBe(true);
	});

	it("rejects a judge that does not wait_for every voter", () => {
		const def = voteDef([
			agent("v1"),
			agent("v2"),
			agent("v3"),
			agent("judge", { waitsFor: ["v1", "v2"] }), // misses v3
		]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("missing voter 'v3'"))).toBe(true);
	});

	it("rejects a voter that reports_to another voter (would serialize wave 0)", () => {
		// v1 reports_to v2 → buildDependencyGraph makes v2 depend on v1, splitting the
		// voters across waves. Validation must reject this so its waitsFor-only partition
		// stays congruent with the dependency graph that actually gets built.
		const def = voteDef([
			agent("v1", { reportsTo: ["v2"] }),
			agent("v2"),
			agent("judge", { waitsFor: ["v1", "v2"] }),
		]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("voter 'v1' must not declare reports_to"))).toBe(true);
	});

	it("rejects a judge that reports_to a voter (structural cycle)", () => {
		// judge waits_for v1 AND reports_to v1 → v1 depends on judge while judge depends on
		// v1: a cycle. Vote validation must reject it up front rather than lean on the
		// downstream detectCycles pass that direct PipelineController callers may skip.
		const def = voteDef([agent("v1"), agent("v2"), agent("judge", { waitsFor: ["v1", "v2"], reportsTo: ["v1"] })]);
		const errors = validateSwarmDefinition(def);
		expect(errors.some(e => e.includes("judge 'judge' must not declare reports_to"))).toBe(true);
	});

	it("the rejected voter-reports_to config would split voters across waves (proves the contract)", () => {
		// Demonstrates the broken DAG the validation guards against: with reports_to present
		// the voters no longer share wave 0.
		const def = voteDef([
			agent("v1", { reportsTo: ["v2"] }),
			agent("v2"),
			agent("judge", { waitsFor: ["v1", "v2"] }),
		]);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		// v1 must precede v2 (v2 depends on v1 via reports_to), so they are NOT in one wave.
		const wave0 = waves[0];
		expect(wave0).toEqual(["v1"]);
		expect(wave0).not.toContain("v2");
	});
});

// ============================================================================
// DAG — waves and aggregator detection
// ============================================================================

describe("vote mode DAG", () => {
	it("places voters in wave 0 and the judge in wave 1", () => {
		const def = happyVoteDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		expect(waves).toHaveLength(2);
		expect(waves[0].sort()).toEqual(["voter1", "voter2", "voter3"]);
		expect(waves[1]).toEqual(["judge"]);
	});

	it("gives voters no implicit chain (all voters share wave 0)", () => {
		// Three voters declared in order; in pipeline mode they would chain into 3 waves.
		const def = happyVoteDef(3);
		const deps = buildDependencyGraph(def);
		// Each voter depends on nothing; only the judge has deps.
		expect(deps.get("voter1")!.size).toBe(0);
		expect(deps.get("voter2")!.size).toBe(0);
		expect(deps.get("voter3")!.size).toBe(0);
		expect([...deps.get("judge")!].sort()).toEqual(["voter1", "voter2", "voter3"]);
	});

	it("findVoteAggregator identifies the judge for a vote definition", () => {
		expect(findVoteAggregator(happyVoteDef(2))).toBe("judge");
	});

	it("findVoteAggregator returns null for non-vote modes", () => {
		const def = happyVoteDef(2);
		def.mode = "pipeline";
		expect(findVoteAggregator(def)).toBeNull();
	});
});

// ============================================================================
// Pipeline — the judge receives every voter's output (reuses executeSwarmAgent)
// ============================================================================

describe("PipelineController — vote reduce", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-vote-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it("injects all voter outputs into the judge's system prompt", async () => {
		// Each runSubprocess call returns a distinct answer keyed by the agent name so we
		// can assert the judge's prompt carries every voter output. runSubprocess builds
		// the system prompt from agent.role + agent.extraContext, so injection through the
		// derived judge agent is observable on the captured options.
		const spy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async (opts: ExecutorOptions) => {
			const name = opts.agent.name;
			return mockResult({ agent: name, output: `ANSWER_FROM_${name}` });
		});

		const def = happyVoteDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const controller = new PipelineController(def, waves, stateTracker);
		const result = await controller.run({ workspace });

		expect(result.status).toBe("completed");
		// 3 voters + 1 judge = 4 subprocess invocations.
		expect(spy).toHaveBeenCalledTimes(4);

		const judgeCall = spy.mock.calls.find(c => c[0].agent.name === "judge");
		expect(judgeCall).toBeDefined();
		const judgePrompt = judgeCall![0].agent.systemPrompt ?? "";
		// Every voter output is present in the judge's context.
		expect(judgePrompt).toContain("ANSWER_FROM_voter1");
		expect(judgePrompt).toContain("ANSWER_FROM_voter2");
		expect(judgePrompt).toContain("ANSWER_FROM_voter3");
		// The judge is prompted to reduce, not concatenate.
		expect(judgePrompt).toContain("JUDGE");
		expect(judgePrompt.toLowerCase()).toContain("consensus");
	});

	it("does not inject voter outputs into the voters themselves", async () => {
		const spy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockImplementation(async (opts: ExecutorOptions) =>
				mockResult({ agent: opts.agent.name, output: `ANSWER_FROM_${opts.agent.name}` }),
			);

		const def = happyVoteDef(2);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		await new PipelineController(def, waves, stateTracker).run({ workspace });

		const voterCall = spy.mock.calls.find(c => c[0].agent.name === "voter1");
		expect(voterCall).toBeDefined();
		const voterPrompt = voterCall![0].agent.systemPrompt ?? "";
		expect(voterPrompt).not.toContain("JUDGE");
		expect(voterPrompt).not.toContain("ANSWER_FROM_voter2");
	});

	it("still reduces when one voter fails (failure surfaced to the judge)", async () => {
		const spy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async (opts: ExecutorOptions) => {
			const name = opts.agent.name;
			if (name === "voter2") {
				return mockResult({ agent: name, exitCode: 1, output: "", error: "boom" });
			}
			return mockResult({ agent: name, output: `ANSWER_FROM_${name}` });
		});

		const def = happyVoteDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const result = await new PipelineController(def, waves, stateTracker).run({ workspace });

		// The failed voter contributes a non-zero exit, so the pipeline reports failed
		// overall, but the judge still runs and reduces the surviving outputs.
		expect(spy.mock.calls.some(c => c[0].agent.name === "judge")).toBe(true);
		const judgeCall = spy.mock.calls.find(c => c[0].agent.name === "judge")!;
		const judgePrompt = judgeCall[0].agent.systemPrompt ?? "";
		expect(judgePrompt).toContain("ANSWER_FROM_voter1");
		expect(judgePrompt).toContain("ANSWER_FROM_voter3");
		// The failed voter is surfaced rather than silently dropped.
		expect(judgePrompt).toContain("voter failed");
		expect(result.errors.some(e => e.includes("voter2"))).toBe(true);
	});

	it("downgrades the judge instruction when every voter fails (no fabricated consensus)", async () => {
		const spy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async (opts: ExecutorOptions) => {
			const name = opts.agent.name;
			if (name === "judge") {
				return mockResult({ agent: name, output: "report" });
			}
			return mockResult({ agent: name, exitCode: 1, output: "", error: `boom-${name}` });
		});

		const def = happyVoteDef(3);
		const waves = buildExecutionWaves(buildDependencyGraph(def));
		const stateTracker = new StateTracker(workspace, def.name);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

		const result = await new PipelineController(def, waves, stateTracker).run({ workspace });

		expect(result.status).toBe("failed");
		const judgeCall = spy.mock.calls.find(c => c[0].agent.name === "judge")!;
		const judgePrompt = judgeCall[0].agent.systemPrompt ?? "";
		// All voters failed: the judge must be told NOT to fabricate a consensus.
		expect(judgePrompt).toContain("EVERY voter failed");
		expect(judgePrompt).toContain("Do NOT fabricate a consensus");
		// And must NOT carry the consensus-producing instruction.
		expect(judgePrompt).not.toContain("produce a single consolidated answer");
	});
});
