import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TaskRegistry } from "@oh-my-pi/pi-coding-agent/task/registry";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { CheckTaskTool } from "@oh-my-pi/pi-coding-agent/tools/check-task";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("CheckTaskTool", () => {
	let tool: CheckTaskTool;
	let registry: TaskRegistry;

	beforeEach(() => {
		registry = new TaskRegistry();
		tool = new CheckTaskTool(registry);
	});

	afterEach(() => {
		registry.cleanup();
	});

	it("returns status for running task", async () => {
		const taskId = Snowflake.next();
		const abortController = new AbortController();
		const { promise } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController,
			promise,
		});

		const result = await tool.execute("call-1", { task_id: taskId });

		expect(result.details?.status).toBe("running");
		expect(result.details?.taskId).toBe(taskId);
		expect(result.content[0]).toMatchObject({
			type: "text",
		});
		expect((result.content[0] as any).text).toContain("running");
	});

	it("returns result for completed task", async () => {
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		registry.register(taskId, {
			id: taskId,
			status: "completed",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			completedAt: Date.now() + 1000,
			progress: [],
			result: [
				{
					index: 0,
					id: "result-1",
					agent: "test-agent",
					agentSource: "bundled",
					task: "test-task",
					exitCode: 0,
					output: "Task completed successfully",
					stderr: "",
					truncated: false,
					durationMs: 1000,
					tokens: 10,
				},
			],
			abortController: new AbortController(),
			promise,
		});

		const result = await tool.execute("call-1", { task_id: taskId });

		expect(result.details?.status).toBe("completed");
		expect(result.details?.result).toBeDefined();
		expect(result.content[0]).toMatchObject({
			type: "text",
		});
		expect((result.content[0] as any).text).toContain("completed");

		resolve({ content: [{ type: "text", text: "done" }] });
	});

	it("returns error for failed task", async () => {
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		const errorMsg = "Task execution failed";

		registry.register(taskId, {
			id: taskId,
			status: "failed",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			completedAt: Date.now() + 1000,
			progress: [],
			error: errorMsg,
			abortController: new AbortController(),
			promise,
		});

		const result = await tool.execute("call-1", { task_id: taskId });

		expect(result.details?.status).toBe("failed");
		expect(result.details?.error).toBe(errorMsg);
		expect(result.content[0]).toMatchObject({
			type: "text",
		});
		expect((result.content[0] as any).text).toContain("failed");

		resolve({ content: [{ type: "text", text: "error" }] });
	});

	it("returns not_found for unknown task", async () => {
		const unknownId = "unknown-task-id";

		const result = await tool.execute("call-1", { task_id: unknownId });

		expect(result.details?.status).toBe("not_found");
		expect(result.details?.taskId).toBe(unknownId);
		expect(result.details?.message).toContain("not found");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: `Task ${unknownId} not found.`,
		});
	});

	it("includes duration for completed task", async () => {
		const taskId = Snowflake.next();
		const createdAt = Date.now();
		const _completedAt = createdAt + 5000; // 5 seconds
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		registry.register(taskId, {
			id: taskId,
			status: "completed",
			agent: "test-agent",
			description: "Test task",
			createdAt,
			completedAt: createdAt + 5000,
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		const result = await tool.execute("call-1", { task_id: taskId });

		const text = (result.content[0] as any).text;
		expect(text).toContain("Duration: 5s");

		resolve({ content: [{ type: "text", text: "done" }] });
	});

	it("includes result count for completed task", async () => {
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		const resultItems: SingleResult[] = [
			{
				index: 0,
				id: "result-1",
				agent: "test-agent",
				agentSource: "bundled",
				task: "test-task",
				exitCode: 0,
				output: "result1",
				stderr: "",
				truncated: false,
				durationMs: 1000,
				tokens: 10,
			},
			{
				index: 1,
				id: "result-2",
				agent: "test-agent",
				agentSource: "bundled",
				task: "test-task",
				exitCode: 0,
				output: "result2",
				stderr: "",
				truncated: false,
				durationMs: 1000,
				tokens: 10,
			},
			{
				index: 2,
				id: "result-3",
				agent: "test-agent",
				agentSource: "bundled",
				task: "test-task",
				exitCode: 0,
				output: "result3",
				stderr: "",
				truncated: false,
				durationMs: 1000,
				tokens: 10,
			},
		];

		registry.register(taskId, {
			id: taskId,
			status: "completed",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			completedAt: Date.now() + 1000,
			progress: [],
			result: resultItems,
			abortController: new AbortController(),
			promise,
		});

		const result = await tool.execute("call-1", { task_id: taskId });

		const text = (result.content[0] as any).text;
		expect(text).toContain("Results: 3 item(s)");

		resolve({ content: [{ type: "text", text: "done" }] });
	});
});
