import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { AgentOutputManager, TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import type { ExecutorOptions } from "../../src/task/executor";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const TEST_AGENT: AgentDefinition = {
	name: "worker",
	description: "test worker",
	systemPrompt: "test",
	source: "bundled",
};

function createToolSession(asyncJobManager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp/test-task-async-batch",
		hasUI: false,
		orchestratorMode: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"task.maxConcurrency": 2,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		agentOutputManager: new AgentOutputManager(() => null),
		asyncJobManager,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
	};
}

describe("TaskTool async batching", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delivers one completion for a multi-task background batch", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [TEST_AGENT],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(
			async (options: ExecutorOptions): Promise<SingleResult> => ({
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				description: options.description,
				exitCode: 0,
				output: `done:${options.id}`,
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
			}),
		);
		const tool = await TaskTool.create(createToolSession(manager));

		const result = await tool.execute("call-1", {
			agent: "worker",
			tasks: [
				{ id: "alpha", description: "Alpha task", assignment: "Handle alpha" },
				{ id: "beta", description: "Beta task", assignment: "Handle beta" },
			],
		});
		const batchJobId = result.details?.async?.jobId;
		if (!batchJobId) throw new Error("Expected batch job ID");

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text content");
		expect(result.content[0].text).toContain("Started background task batch using worker (2 tasks)");
		expect(manager.getAllJobs()).toHaveLength(1);
		expect(manager.getJob(batchJobId)?.type).toBe("task");

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toHaveLength(1);
		expect(completions[0]?.jobId).toBe(batchJobId);
		expect(completions[0]?.text).toContain("2/2 succeeded");
		expect(completions[0]?.text).toContain("done:0-alpha");
		expect(completions[0]?.text).toContain("done:1-beta");
	});
});
