import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { PipelineController } from "../pipeline";
import type { SwarmDefinition } from "../schema";
import { StateTracker } from "../state";

const mockResult = {
	index: 0,
	id: "test-agent-0",
	agent: "test",
	agentSource: "project",
	task: "test task",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 100,
	tokens: 0,
} as SingleResult;

let projectDir: string;
let swarmWorkspace: string;

beforeEach(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-project-"));
	swarmWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-workspace-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(projectDir, { recursive: true, force: true });
	await fs.rm(swarmWorkspace, { recursive: true, force: true });
});

describe("per-agent workspace resolution in pipeline", () => {
	it("resolves agent.workspace relative to swarm.workspace, not to swarm.workspace", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(mockResult);

		// Build a SwarmDefinition with two agents: one with workspace override
		const def: SwarmDefinition = {
			name: "test-swarm",
			workspace: swarmWorkspace,
			mode: "parallel",
			targetCount: 1,
			agents: new Map([
				[
					"agent-a",
					{
						name: "agent-a",
						role: "tester",
						task: "do something",
						reportsTo: [],
						waitsFor: [],
						workspace: "wt/auth",
					},
				],
				[
					"agent-b",
					{
						name: "agent-b",
						role: "reviewer",
						task: "review",
						reportsTo: [],
						waitsFor: [],
					},
				],
			]),
			agentOrder: ["agent-a", "agent-b"],
		};

		const stateTracker = new StateTracker(swarmWorkspace, "test-swarm");
		await stateTracker.init(["agent-a", "agent-b"], 1, "parallel");

		const controller = new PipelineController(def, [["agent-a", "agent-b"]], stateTracker);
		await controller.run({ workspace: swarmWorkspace });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(2);

		// Find which call was for agent-a vs agent-b
		const calls = runSubprocessSpy.mock.calls;
		const callA = calls.find(c => c[0].id?.includes("agent-a"))![0];
		const callB = calls.find(c => c[0].id?.includes("agent-b"))![0];

		// Agent A with workspace: "wt/auth" should resolve to swarmWorkspace/wt/auth
		expect(callA.cwd).toBe(path.join(swarmWorkspace, "wt/auth"));

		// Agent B with no workspace override should use swarmWorkspace
		expect(callB.cwd).toBe(swarmWorkspace);
	});
});
