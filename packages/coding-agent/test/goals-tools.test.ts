import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { goalToolResponse, type ThreadGoal } from "../src/goals";
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "../src/goals/tools/tools";
import type { ToolSession } from "../src/tools";

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
	return {
		threadId: "thread-a",
		goalId: "goal-a",
		objective: "finish the adaptation",
		status: "active",
		tokenBudget: 100,
		tokensUsed: 40,
		timeUsedSeconds: 12,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function sessionWithGoals(state: { current: ThreadGoal | null }): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "goals.enabled": true }),
		isToolDiscoveryEnabled: () => false,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async names => names,
		goals: {
			get: async () => state.current,
			create: async input => {
				state.current = goal({ objective: input.objective, tokenBudget: input.tokenBudget ?? null });
				return state.current;
			},
			complete: async () => {
				state.current = state.current ? { ...state.current, status: "complete" } : null;
				return state.current;
			},
		},
	};
}

function details<T>(value: { details?: T }): T {
	if (!value.details) throw new Error("Expected tool result details.");
	return value.details;
}

describe("goal tools", () => {
	it("get_goal returns null when no thread goal exists", async () => {
		const result = await new GetGoalTool(sessionWithGoals({ current: null })).execute();
		const response = details(result);
		expect(response.goal).toBeNull();
		expect(response.remainingTokens).toBeNull();
	});

	it("create_goal creates a goal with the requested objective and budget", async () => {
		const result = await new CreateGoalTool(sessionWithGoals({ current: null })).execute("call-a", {
			objective: "ship goals",
			tokenBudget: 250,
		});
		const response = details(result);
		expect(response.goal?.objective).toBe("ship goals");
		expect(response.goal?.tokenBudget).toBe(250);
		expect(response.completionBudgetReport).toBeNull();
	});

	it("update_goal only exposes complete in its schema and returns a completion budget report", async () => {
		const state = { current: goal() };
		const tool = new UpdateGoalTool(sessionWithGoals(state));
		expect(tool.parameters.properties.status.const).toBe("complete");

		const result = await tool.execute("call-a", { status: "complete" });
		const response = details(result);
		expect(response.goal?.status).toBe("complete");
		expect(response.completionBudgetReport).toContain("Goal completed using 40 tokens");
	});
});

describe("goal tool response", () => {
	it("reports remaining tokens for budgeted goals", () => {
		expect(goalToolResponse(goal(), false).remainingTokens).toBe(60);
	});
});
