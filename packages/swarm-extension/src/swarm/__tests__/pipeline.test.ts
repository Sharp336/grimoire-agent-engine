import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutorOptions, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { buildDependencyGraph, buildExecutionWaves } from "../dag";
import { PipelineController } from "../pipeline";
import { parseSwarmYaml } from "../schema";
import { StateTracker } from "../state";

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pipeline-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

function successfulResult(options: ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		exitCode: 0,
		output: `${options.agent.name} complete`,
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 0,
		requests: 1,
	};
}

describe("PipelineController", () => {
	it("runs a wave concurrently, waits before dispatching dependents, and returns every native result", async () => {
		const definition = parseSwarmYaml(`
swarm:
  name: baseline
  workspace: .
  mode: parallel
  agents:
    beta:
      role: researcher
      task: Research beta.
    alpha:
      role: researcher
      task: Research alpha.
    synth:
      role: synthesizer
      task: Synthesize the findings.
      waits_for: [alpha, beta]
`);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);

		const releaseFirstWave = Promise.withResolvers<void>();
		const firstWaveStarted = Promise.withResolvers<void>();
		const started: string[] = [];
		let firstWaveStarts = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		const runSubprocess = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			const name = options.agent.name;
			started.push(name);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (name !== "synth") {
				firstWaveStarts++;
				if (firstWaveStarts === 2) firstWaveStarted.resolve();
				await releaseFirstWave.promise;
			}
			inFlight--;
			return successfulResult(options);
		});

		const controller = new PipelineController(definition, waves, stateTracker);
		const pending = controller.run({ workspace });

		await firstWaveStarted.promise;
		expect(new Set(started)).toEqual(new Set(["alpha", "beta"]));
		expect(started).not.toContain("synth");
		expect(maxInFlight).toBe(2);

		releaseFirstWave.resolve();
		const result = await pending;

		expect(started.at(-1)).toBe("synth");
		expect(runSubprocess).toHaveBeenCalledTimes(3);
		expect(runSubprocess.mock.calls.map(([options]) => options.cwd)).toEqual([workspace, workspace, workspace]);
		expect(result).toMatchObject({ status: "completed", iterations: 1, errors: [] });
		expect(result.agentResults.get("alpha")?.map(item => item.output)).toEqual(["alpha complete"]);
		expect(result.agentResults.get("beta")?.map(item => item.output)).toEqual(["beta complete"]);
		expect(result.agentResults.get("synth")?.map(item => item.output)).toEqual(["synth complete"]);
	});
});
