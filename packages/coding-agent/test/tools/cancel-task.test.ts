import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TaskRegistry } from "@oh-my-pi/pi-coding-agent/task/registry";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { CancelTaskTool } from "@oh-my-pi/pi-coding-agent/tools/cancel-task";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("CancelTaskTool", () => {
	let tool: CancelTaskTool;
	let registry: TaskRegistry;

	beforeEach(() => {
		registry = new TaskRegistry();
		tool = new CancelTaskTool(registry);
	});

	afterEach(() => {
		registry.cleanup();
	});

	it("cancels a running task", async () => {
		const taskId = Snowflake.next();
		const abortController = new AbortController();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

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

		expect(result.details?.status).toBe("cancelled");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: `Task ${taskId} cancelled`,
		});

		const task = registry.get(taskId);
		expect(task?.status).toBe("cancelled");

		// Verify abort signal was triggered
		expect(abortController.signal.aborted).toBe(true);

		resolve({ content: [{ type: "text", text: "aborted" }] });
	});

	it("returns not_found for unknown task", async () => {
		const unknownId = "unknown-task-id";

		const result = await tool.execute("call-1", { task_id: unknownId });

		expect(result.details?.status).toBe("not_found");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: `Task ${unknownId} not found`,
		});
	});

	it("returns already_completed for finished task", async () => {
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		registry.register(taskId, {
			id: taskId,
			status: "completed",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			completedAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		const result = await tool.execute("call-1", { task_id: taskId });

		expect(result.details?.status).toBe("already_completed");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: `Task ${taskId} already completed`,
		});

		resolve({ content: [{ type: "text", text: "done" }] });
	});

	it("propagates abort signal to task", async () => {
		const taskId = Snowflake.next();
		const abortController = new AbortController();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

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

		// Verify signal is not aborted before cancellation
		expect(abortController.signal.aborted).toBe(false);

		await tool.execute("call-1", { task_id: taskId });

		// Verify signal is aborted after cancellation
		expect(abortController.signal.aborted).toBe(true);

		resolve({ content: [{ type: "text", text: "aborted" }] });
	});

	it("handles multiple cancellation attempts on same task", async () => {
		const taskId = Snowflake.next();
		const abortController = new AbortController();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

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

		// First cancellation should succeed
		const result1 = await tool.execute("call-1", { task_id: taskId });
		expect(result1.details?.status).toBe("cancelled");

		// Second cancellation should report already_completed
		const result2 = await tool.execute("call-2", { task_id: taskId });
		expect(result2.details?.status).toBe("already_completed");

		resolve({ content: [{ type: "text", text: "aborted" }] });
	});
});
