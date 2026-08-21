import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
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

describe("nested eval agent turn-budget accounting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("propagates nested eval output through the eval-spawned parent exactly once", async () => {
		const parentOutputTokens = 1_234;
		const nestedOutputTokens = 2_345;
		const turnBudgetTokens = 100_000;
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const rootSessionManager = SessionManager.inMemory();
		const childSessionManager = SessionManager.inMemory();
		rootSessionManager.beginTurnBudget(turnBudgetTokens, true);
		childSessionManager.beginTurnBudget(turnBudgetTokens, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
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
});
