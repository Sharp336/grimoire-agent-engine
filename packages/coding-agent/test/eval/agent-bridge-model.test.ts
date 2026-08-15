import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import * as taskDiscovery from "../../src/task/discovery";
import * as taskExecutor from "../../src/task/executor";
import { resolveEffectiveSubagentPolicy } from "../../src/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["@task"],
} satisfies AgentDefinition;

const reviewerAgent = {
	name: "reviewer",
	description: "Reviewer agent",
	systemPrompt: "Review the task.",
	source: "bundled",
	model: ["@smol"],
} satisfies AgentDefinition;

function makeSession(settings?: Settings): ToolSession {
	const resolved =
		settings ??
		Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: resolved,
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "openai/gpt-4o",
		getModelString: () => "anthropic/claude-sonnet-5",
		getArtifactsDir: () => null,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
	};
}

function mockAgents(agents: AgentDefinition[] = [taskAgent, reviewerAgent]): void {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function singleResult(options: taskExecutor.ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

describe("eval agent() explicit model routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards an explicit model from agent() to structured-subagent resolution", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const explicitModel = "google-antigravity/gemini-3.1-pro:high";

		await runEvalAgent(
			{ prompt: "review this", agent: "reviewer", model: explicitModel },
			{ session: makeSession() },
		);

		expect(runSpy.mock.calls[0]?.[0].modelOverride).toEqual([explicitModel]);
	});

	it("lets an explicit request model beat task.agentModelOverrides for the reviewer", async () => {
		mockAgents();
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			modelRoles: {
				slow: "anthropic/claude-sonnet-5",
				Reviewer: "anthropic/claude-sonnet-5",
			},
		});
		settings.override("task.agentModelOverrides", { reviewer: "@slow" });
		const explicitModel = "google-antigravity/gemini-3.1-pro:high";

		const policy = await resolveEffectiveSubagentPolicy({
			session: makeSession(settings),
			invocationKind: "eval",
			assignment: "review",
			agent: "reviewer",
			model: explicitModel,
		});

		expect(policy.modelOverride).toEqual([explicitModel]);
		expect(policy.modelRole).toBeUndefined();
	});

	it("preserves reviewer settings override when no explicit model is supplied", async () => {
		mockAgents();
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			modelRoles: {
				slow: "anthropic/claude-sonnet-5",
			},
		});
		settings.override("task.agentModelOverrides", { reviewer: "@slow" });

		const policy = await resolveEffectiveSubagentPolicy({
			session: makeSession(settings),
			invocationKind: "eval",
			assignment: "review",
			agent: "reviewer",
		});

		expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-5"]);
		expect(policy.modelRole).toBe("slow");
	});

	it("does not treat a model selector as an agent name when agent is valid", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await runEvalAgent(
			{
				prompt: "review",
				agent: "reviewer",
				model: "gemini-3.1-pro:high",
			},
			{ session: makeSession() },
		);

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].agent.name).toBe("reviewer");
		expect(runSpy.mock.calls[0]?.[0].modelOverride).toEqual(["gemini-3.1-pro:high"]);
	});

	it("surfaces model-looking selectors passed as agent with a separation hint", async () => {
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const modelLike = "google-antigravity/gemini-3.1-pro:high";

		await expect(runEvalAgent({ prompt: "review", agent: modelLike }, { session: makeSession() })).rejects.toThrow(
			/looks like a model selector.*model:/s,
		);
	});

	it("forwards an invalid explicit model to model resolution instead of treating it as an agent", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const invalidModel = "missing-provider/missing-model";

		await runEvalAgent(
			{
				prompt: "review",
				agent: "reviewer",
				model: invalidModel,
			},
			{ session: makeSession() },
		);

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].agent.name).toBe("reviewer");
		expect(runSpy.mock.calls[0]?.[0].modelOverride).toEqual([invalidModel]);
	});
});
