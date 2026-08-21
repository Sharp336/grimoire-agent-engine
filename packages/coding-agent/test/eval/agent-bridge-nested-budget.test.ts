import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalBudget } from "@oh-my-pi/pi-coding-agent/eval/budget-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createUsage(output: number) {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createResult(id: string, output: number): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: output,
		requests: 1,
		usage: createUsage(output),
	};
}

function createBudgetSession(sessionManager: SessionManager, agentId?: string): ToolSession {
	return {
		cwd: "/tmp",
		settings: Settings.isolated(),
		getSessionSpawns: () => "*",
		getSessionFile: () => null,
		getTurnBudget: () => sessionManager.getTurnBudget(),
		recordEvalSubagentUsage: (output: number) => sessionManager.recordEvalSubagentOutput(output),
		...(agentId !== undefined ? { getAgentId: () => agentId } : {}),
	} as unknown as ToolSession;
}

function createAgent(): AgentDefinition {
	return {
		name: "task",
		description: "Task agent",
		systemPrompt: "Handle task",
		source: "bundled",
	};
}

describe("nested eval agent turn-budget accounting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("propagates nested eval output through the eval-spawned parent exactly once", async () => {
		const parentOutputTokens = 1_234;
		const nestedOutputTokens = 2_345;
		const turnBudgetTokens = 100_000;
		const rootSessionManager = SessionManager.inMemory();
		const childSessionManager = SessionManager.inMemory();
		rootSessionManager.beginTurnBudget(turnBudgetTokens, true);
		childSessionManager.beginTurnBudget(turnBudgetTokens, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [createAgent()], projectAgentsDir: null });
		let invocation = 0;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			invocation += 1;
			if (invocation === 1) {
				await runEvalAgent(
					{ prompt: "nested work", agent: "task" },
					{ session: createBudgetSession(childSessionManager, options.id) },
				);
				return createResult(options.id, parentOutputTokens);
			}
			return createResult(options.id, nestedOutputTokens);
		});

		await runEvalAgent(
			{ prompt: "parent work", agent: "task" },
			{ session: createBudgetSession(rootSessionManager) },
		);

		expect(invocation).toBe(2);
		expect(childSessionManager.getTurnBudget().spent).toBe(nestedOutputTokens);
		expect(rootSessionManager.getTurnBudget()).toEqual({
			total: turnBudgetTokens,
			spent: parentOutputTokens + nestedOutputTokens,
			hard: true,
		});
	});

	it("blocks later nested eval spawns after the ancestor hard budget is exhausted", async () => {
		const parentOutputTokens = 100;
		const nestedOutputTokens = 2_500;
		const rootBudgetTokens = 2_000;
		const rootSessionManager = SessionManager.inMemory();
		const childSessionManager = SessionManager.inMemory();
		rootSessionManager.beginTurnBudget(rootBudgetTokens, true);
		childSessionManager.beginTurnBudget(100_000, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [createAgent()], projectAgentsDir: null });
		let invocation = 0;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			invocation += 1;
			if (invocation === 1) {
				const childSession = createBudgetSession(childSessionManager, options.id);
				await runEvalAgent({ prompt: "first nested work", agent: "task" }, { session: childSession });
				await expect(
					runEvalAgent({ prompt: "second nested work", agent: "task" }, { session: childSession }),
				).rejects.toThrow("agent() blocked: turn token budget exhausted");
				return createResult(options.id, parentOutputTokens);
			}
			return createResult(options.id, nestedOutputTokens);
		});

		await runEvalAgent(
			{ prompt: "parent work", agent: "task" },
			{ session: createBudgetSession(rootSessionManager) },
		);

		expect(invocation).toBe(2);
		expect(childSessionManager.getTurnBudget().spent).toBe(nestedOutputTokens);
		expect(rootSessionManager.getTurnBudget()).toEqual({
			total: rootBudgetTokens,
			spent: parentOutputTokens + nestedOutputTokens,
			hard: true,
		});
	});

	it("reports the ancestor budget through nested eval budget helpers", async () => {
		const rootBudgetTokens = 4_000;
		const nestedOutputTokens = 1_250;
		const rootSessionManager = SessionManager.inMemory();
		const childSessionManager = SessionManager.inMemory();
		rootSessionManager.beginTurnBudget(rootBudgetTokens, false);
		childSessionManager.beginTurnBudget(100_000, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [createAgent()], projectAgentsDir: null });
		let invocation = 0;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			invocation += 1;
			if (invocation === 1) {
				const childSession = createBudgetSession(childSessionManager, options.id);
				expect(await runEvalBudget({}, { session: childSession })).toEqual({
					total: rootBudgetTokens,
					spent: 0,
					hard: false,
				});
				await runEvalAgent({ prompt: "nested work", agent: "task" }, { session: childSession });
				expect(await runEvalBudget({}, { session: childSession })).toEqual({
					total: rootBudgetTokens,
					spent: nestedOutputTokens,
					hard: false,
				});
				return createResult(options.id, 0);
			}
			return createResult(options.id, nestedOutputTokens);
		});

		await runEvalAgent(
			{ prompt: "parent work", agent: "task" },
			{ session: createBudgetSession(rootSessionManager) },
		);

		expect(invocation).toBe(2);
		expect(rootSessionManager.getTurnBudget()).toEqual({
			total: rootBudgetTokens,
			spent: nestedOutputTokens,
			hard: false,
		});
	});
});
