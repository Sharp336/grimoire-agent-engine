import { describe, expect, test } from "bun:test";
import {
	applyRpcTodoOperation,
	controlRpcCheckpoint,
	controlRpcGoal,
	controlRpcLoop,
	RpcTodoOperationError,
	setRpcModelRole,
	setRpcServiceTier,
	setRpcTodoPhases,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-execution-controls";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { createTestSession } from "./utilities";

describe("RPC execution controls", () => {
	test("persists replacement and semantic todo mutations through SessionManager", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			setRpcTodoPhases(ctx.session, [{ name: "Build", tasks: [{ content: "Implement", status: "in_progress" }] }]);
			const appended = applyRpcTodoOperation(ctx.session, {
				op: "append",
				phase: "Build",
				items: ["Verify"],
			});
			expect(appended).toEqual([
				{
					name: "Build",
					tasks: [
						{ content: "Implement", status: "in_progress" },
						{ content: "Verify", status: "pending" },
					],
				},
			]);
			expect(getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch())).toEqual(appended);

			const beforeView = ctx.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE).length;
			expect(applyRpcTodoOperation(ctx.session, { op: "view" })).toEqual(appended);
			const afterView = ctx.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE).length;
			expect(afterView).toBe(beforeView);

			expect(() => applyRpcTodoOperation(ctx.session, { op: "start", task: "Missing" })).toThrow(
				RpcTodoOperationError,
			);
			expect(getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch())).toEqual(appended);
		} finally {
			await ctx.cleanup();
		}
	});

	test("controls the complete goal lifecycle through GoalRuntime", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const created = await controlRpcGoal(ctx.session, {
				op: "create",
				objective: "Ship RPC v3",
				tokenBudget: 10_000,
			});
			expect(created.state).toMatchObject({
				enabled: true,
				goal: { objective: "Ship RPC v3", status: "active", tokenBudget: 10_000 },
			});

			const replaced = await controlRpcGoal(ctx.session, {
				op: "replace",
				objective: "Ship public RPC v3",
				tokenBudget: 12_000,
			});
			expect(replaced.goal).toMatchObject({ objective: "Ship public RPC v3", tokenBudget: 12_000 });
			expect((await controlRpcGoal(ctx.session, { op: "pause" })).goal?.status).toBe("paused");
			expect((await controlRpcGoal(ctx.session, { op: "resume" })).goal?.status).toBe("active");
			expect((await controlRpcGoal(ctx.session, { op: "set_budget", tokenBudget: 20_000 })).goal?.tokenBudget).toBe(
				20_000,
			);
			expect((await controlRpcGoal(ctx.session, { op: "clear_budget" })).goal?.tokenBudget).toBeUndefined();
			expect((await controlRpcGoal(ctx.session, { op: "complete" })).goal?.status).toBe("complete");
			expect((await controlRpcGoal(ctx.session, { op: "get" })).state?.reason).toBe("completed");

			await controlRpcGoal(ctx.session, { op: "create", objective: "Post-release cleanup" });
			const dropped = await controlRpcGoal(ctx.session, { op: "drop" });
			expect(dropped.state).toBeNull();
			expect(dropped.goal).toMatchObject({ objective: "Post-release cleanup", status: "dropped" });
		} finally {
			await ctx.cleanup();
		}
	});
	test("controls model roles and provider-family service tiers explicitly", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			expect(setRpcServiceTier(ctx.session, "anthropic", "priority")).toEqual({
				family: "anthropic",
				tier: "priority",
				serviceTiers: { anthropic: "priority" },
			});
			expect(setRpcServiceTier(ctx.session, "anthropic", null)).toEqual({
				family: "anthropic",
				tier: null,
				serviceTiers: {},
			});
			await expect(setRpcModelRole(ctx.session, "unconfigured")).rejects.toThrow(
				"Model role is not configured: unconfigured",
			);
		} finally {
			await ctx.cleanup();
		}
	});
	test("persists and rewinds AgentSession checkpoints without tool-result fabrication", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const created = await controlRpcCheckpoint(ctx.session, {
				op: "create",
				goal: "Investigate recovery",
			});
			expect(created.active).toMatchObject({ goal: "Investigate recovery" });
			expect(ctx.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({
					type: "custom",
					customType: "rpc_checkpoint",
					data: { goal: "Investigate recovery", startedAt: created.active?.startedAt },
				}),
			);

			const rewound = await controlRpcCheckpoint(ctx.session, {
				op: "rewind",
				report: "Recovery is deterministic.",
			});
			expect(rewound.active).toBeNull();
			expect(rewound.lastCompleted).toMatchObject({ report: "Recovery is deterministic." });
			expect(ctx.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({ type: "custom_message", customType: "rewind-report" }),
			);
			await expect(controlRpcCheckpoint(ctx.session, { op: "rewind", report: "again" })).rejects.toThrow(
				"Checkpoint already completed",
			);
		} finally {
			await ctx.cleanup();
		}
	});
	test("controls loop lifecycle and consumes iteration authority atomically", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			expect(
				controlRpcLoop(ctx.session, {
					op: "enable",
					action: "compact",
					prompt: "Continue",
					limit: { kind: "iterations", iterations: 2 },
				}),
			).toMatchObject({
				operation: "enable",
				state: {
					enabled: true,
					phase: "running",
					action: "compact",
					prompt: "Continue",
					limit: { kind: "iterations", initial: 2, remaining: 2 },
				},
			});
			expect(ctx.session.beginLoopIteration()).toEqual({ action: "compact", prompt: "Continue" });
			expect(ctx.session.getLoopState().limit).toMatchObject({ remaining: 1 });
			expect(ctx.session.beginLoopIteration()).toEqual({ action: "compact", prompt: "Continue" });
			expect(ctx.session.beginLoopIteration()).toBeUndefined();
			expect(ctx.session.getLoopState()).toMatchObject({ enabled: false, phase: "disabled" });

			controlRpcLoop(ctx.session, { op: "enable" });
			expect(controlRpcLoop(ctx.session, { op: "pause" }).state.phase).toBe("paused");
			expect(() => controlRpcLoop(ctx.session, { op: "resume" })).toThrow("Loop prompt cannot be empty");
			expect(controlRpcLoop(ctx.session, { op: "resume", prompt: "Fresh prompt" }).state).toMatchObject({
				enabled: true,
				phase: "running",
				prompt: "Fresh prompt",
			});
			expect(controlRpcLoop(ctx.session, { op: "disable" }).state).toMatchObject({
				enabled: false,
				phase: "disabled",
			});
		} finally {
			await ctx.cleanup();
		}
	});
});
