import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSource, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { buildDependencyGraph, buildExecutionWaves } from "../../src/swarm/dag";
import * as swarmExecutor from "../../src/swarm/executor";
import { PipelineController } from "../../src/swarm/pipeline";
import { renderSwarmProgress } from "../../src/swarm/render";
import { parseSwarmYaml } from "../../src/swarm/schema";
import { StateTracker as SwarmStateTracker } from "../../src/swarm/state";

const executed: string[] = [];

let workspace: string;

beforeEach(async () => {
	executed.length = 0;
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pipeline-test-"));
	vi.spyOn(swarmExecutor, "executeSwarmAgent").mockImplementation(
		async (agent, index, options): Promise<SingleResult> => {
			executed.push(agent.name);
			const failed = agent.name === "failing";
			const aborted = agent.name === "aborted";
			await options.stateTracker.updateAgent(agent.name, {
				status: failed ? "failed" : "completed",
				iteration: options.iteration,
				completedAt: Date.now(),
				error: failed ? "expected failure" : undefined,
			});
			return {
				index,
				id: `test-${agent.name}`,
				agent: agent.name,
				agentSource: "project" as AgentSource,
				task: agent.task,
				exitCode: failed ? 1 : 0,
				output: failed || aborted ? "" : `${agent.name} completed`,
				stderr: failed ? "expected failure" : "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
				error: failed ? "expected failure" : undefined,
				aborted,
			};
		},
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("PipelineController", () => {
	it("blocks only direct and transitive dependents of a failed agent", async () => {
		const definition = parseSwarmYaml(`
swarm:
  name: failure-gate-test
  workspace: ./workspace
  mode: pipeline
  agents:
    failing:
      role: failing probe
      task: fail
      reports_to: [dependent]
    independent:
      role: independent branch
      task: succeed independently
      reports_to: [independent_child]
    dependent:
      role: blocked child
      task: must not execute
      waits_for: [failing]
      reports_to: [blocked_grandchild]
    independent_child:
      role: successful child
      task: execute after independent succeeds
      waits_for: [independent]
    blocked_grandchild:
      role: transitively blocked child
      task: must not execute
      waits_for: [dependent]
`);
		const dependencies = buildDependencyGraph(definition);
		const waves = buildExecutionWaves(dependencies);
		const stateTracker = new SwarmStateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);
		const controller = new PipelineController(definition, waves, stateTracker);

		const result = await controller.run({ workspace });

		expect(result.status).toBe("failed");
		expect(executed).toEqual(["failing", "independent", "independent_child"]);
		expect(result.agentResults.get("dependent")).toHaveLength(1);
		expect(result.agentResults.get("dependent")?.[0]?.exitCode).toBe(1);
		expect(stateTracker.state.agents.dependent.status).toBe("blocked");
		expect(result.agentResults.get("blocked_grandchild")?.[0]?.exitCode).toBe(1);
		expect(stateTracker.state.agents.blocked_grandchild.status).toBe("blocked");
		const progress = renderSwarmProgress(stateTracker.state).join("\n");
		expect(progress).toContain("[skip] dependent: blocked");
		expect(progress).toContain("2 blocked");
		expect(stateTracker.state.agents.independent_child.status).toBe("completed");
	});

	it("blocks dependents when an upstream agent is aborted with exit code 0", async () => {
		const definition = parseSwarmYaml(`
swarm:
  name: aborted-gate-test
  workspace: ./workspace
  mode: pipeline
  agents:
    aborted:
      role: aborted probe
      task: abort
      reports_to: [dependent]
    dependent:
      role: blocked child
      task: must not execute
      waits_for: [aborted]
`);
		const dependencies = buildDependencyGraph(definition);
		const waves = buildExecutionWaves(dependencies);
		const stateTracker = new SwarmStateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);
		const controller = new PipelineController(definition, waves, stateTracker);

		const result = await controller.run({ workspace });

		expect(result.status).toBe("failed");
		expect(executed).toEqual(["aborted"]);
		expect(stateTracker.state.agents.dependent.status).toBe("blocked");
	});
});
