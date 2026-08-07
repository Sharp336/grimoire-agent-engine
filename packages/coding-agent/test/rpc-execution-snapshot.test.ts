import { describe, expect, test } from "bun:test";
import { projectRpcSessionExecution } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-execution-snapshot";
import { createTestSession } from "./utilities";

describe("RPC execution snapshot", () => {
	test("projects authoritative execution state without transcript inference", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			ctx.session.setTodoPhases([
				{
					name: "Execution",
					tasks: [
						{ content: "Project execution authority", status: "in_progress" },
						{ content: "Verify recovery", status: "pending" },
					],
				},
			]);
			await ctx.session.goalRuntime.createGoal({ objective: "Ship RPC v3", tokenBudget: 12_000 });
			ctx.sessionManager.beginTurnBudget(8_000, true);
			ctx.session.enableLoop({
				action: "compact",
				prompt: "Continue",
				limit: { kind: "iterations", iterations: 3 },
			});

			const snapshot = await projectRpcSessionExecution(ctx.session, {
				applicationApiVersion: 2,
				operations: {
					active: [
						{
							operationId: "operation-1",
							requestId: "request-1",
							command: "prompt",
							status: "started",
							acceptedAt: 10,
							startedAt: 11,
						},
					],
					recent: [],
				},
				pendingInteractions: [
					{
						id: "interaction-1",
						method: "approval",
						startedAt: 12,
						title: "Approve write",
						operationId: "operation-1",
						sensitive: false,
						toolCallId: "tool-call-1",
						toolName: "write",
					},
				],
			});

			expect(snapshot.turn).toMatchObject({
				phase: "idle",
				streaming: false,
				aborting: false,
				activeOperations: [{ operationId: "operation-1", status: "started" }],
			});
			expect(snapshot.queue).toMatchObject({
				state: { steering: [], followUp: [], pendingCount: 0, pendingNextTurnCount: 0 },
			});
			expect(snapshot.goal.state).toMatchObject({
				enabled: true,
				goal: { objective: "Ship RPC v3", tokenBudget: 12_000, tokensUsed: 0 },
			});
			expect(snapshot.goal.turnBudget).toEqual({ total: 8_000, spent: 0, hard: true });
			expect(snapshot.todos.phases).toEqual([
				{
					name: "Execution",
					tasks: [
						{ content: "Project execution authority", status: "in_progress" },
						{ content: "Verify recovery", status: "pending" },
					],
				},
			]);
			expect(snapshot.model).toMatchObject({
				active: { provider: "anthropic", id: "claude-sonnet-4-5" },
				activeRole: "default",
			});
			expect(snapshot.maintenance).toMatchObject({
				compaction: { active: false },
				retry: { active: false, attempt: 0 },
			});
			expect(snapshot.recovery).toEqual({
				retrying: false,
				attempt: 0,
				pendingRecoveredErrors: 0,
				emptyStopRetries: 0,
				unexpectedStopRetries: 0,
				acceptingTerminalEmptyStop: false,
			});
			expect(snapshot.checkpoint).toEqual({ active: null, lastCompleted: null });
			expect(snapshot.tools.active).toContain("read");
			expect(snapshot.tools.inventory.applicationApiVersion).toBe(2);
			expect(snapshot.interactions).toEqual({
				pending: [
					{
						id: "interaction-1",
						method: "approval",
						startedAt: 12,
						title: "Approve write",
						operationId: "operation-1",
						sensitive: false,
						toolCallId: "tool-call-1",
						toolName: "write",
					},
				],
			});
			expect(snapshot.loop).toEqual({
				enabled: true,
				phase: "running",
				action: "compact",
				prompt: "Continue",
				limit: { kind: "iterations", initial: 3, remaining: 3 },
			});
			expect(snapshot.extensions).toEqual({
				loaded: false,
				uiAvailable: false,
				paths: [],
				registeredTools: [],
			});
			expect(snapshot.resources).toEqual({
				mcp: { selectedTools: [], prompts: [] },
			});
		} finally {
			await ctx.cleanup();
		}
	});
});
