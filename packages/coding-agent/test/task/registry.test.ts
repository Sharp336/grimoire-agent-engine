import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TaskRegistry } from "@oh-my-pi/pi-coding-agent/task/registry";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { Snowflake } from "@oh-my-pi/pi-utils";

function generateTaskId(index: number): string {
	return `task_${index}`;
}

describe("TaskRegistry", () => {
	let registry: TaskRegistry;

	beforeEach(() => {
		registry = new TaskRegistry();
	});

	afterEach(() => {
		registry.cleanup();
	});

	it("registers and gets a task", async () => {
		const taskId = generateTaskId(1);
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		const task = registry.get(taskId);
		expect(task).toBeDefined();
		expect(task?.id).toBe(taskId);
		expect(task?.agent).toBe("test-agent");

		resolve({ content: [{ type: "text", text: "done" }] });
	});

	it("returns undefined for unknown id", () => {
		const task = registry.get("unknown-id");
		expect(task).toBeUndefined();
	});

	it("lists all registered tasks", async () => {
		const taskId1 = generateTaskId(2);
		const taskId2 = generateTaskId(3);
		const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		registry.register(taskId1, {
			id: taskId1,
			status: "running",
			agent: "agent-1",
			description: "Task 1",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise: promise1,
		});

		registry.register(taskId2, {
			id: taskId2,
			status: "running",
			agent: "agent-2",
			description: "Task 2",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise: promise2,
		});

		const tasks = registry.list();
		expect(tasks).toHaveLength(2);
		expect(tasks.map(t => t.id)).toEqual([taskId1, taskId2]);

		resolve1({ content: [{ type: "text", text: "done" }] });
		resolve2({ content: [{ type: "text", text: "done" }] });
	});

	it("returns empty array when no tasks", () => {
		const tasks = registry.list();
		expect(tasks).toEqual([]);
	});

	it("cancels a running task", async () => {
		const taskId = generateTaskId(4);
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

		const spyAbort = () => {
			abortController.abort();
			resolve({ content: [{ type: "text", text: "aborted" }] });
		};

		const cancelled = registry.cancel(taskId);
		expect(cancelled).toBe(true);

		const task = registry.get(taskId);
		expect(task?.status).toBe("cancelled");

		spyAbort();
	});

	it("returns false for unknown task on cancel", () => {
		const cancelled = registry.cancel("unknown-id");
		expect(cancelled).toBe(false);
	});

	it("returns false when cancelling already completed task", async () => {
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

		const cancelled = registry.cancel(taskId);
		expect(cancelled).toBe(false);

		resolve({ content: [{ type: "text", text: "done" }] });
	});

	it("enforces max task limit", () => {
		const maxTasks = TaskRegistry.MAX_TASKS;

		// Register tasks up to the limit
		for (let i = 0; i < maxTasks; i++) {
			const taskId = Snowflake.next();
			const { promise } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

			registry.register(taskId, {
				id: taskId,
				status: "running",
				agent: "test-agent",
				description: `Task ${i}`,
				createdAt: Date.now(),
				progress: [],
				abortController: new AbortController(),
				promise,
			});
		}

		// Attempt to register one more task
		const taskId = Snowflake.next();
		const { promise } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		expect(() => {
			registry.register(taskId, {
				id: taskId,
				status: "running",
				agent: "test-agent",
				description: "Over limit",
				createdAt: Date.now(),
				progress: [],
				abortController: new AbortController(),
				promise,
			});
		}).toThrow();
	});

	it("fires onComplete callback when promise resolves", async () => {
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		let completed = false;

		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		registry.onComplete(taskId, () => {
			completed = true;
		});

		resolve({
			content: [{ type: "text", text: "done" }],
			details: { projectAgentsDir: null, results: [], totalDurationMs: 100 },
		});

		await promise;
		expect(completed).toBe(true);

		const task = registry.get(taskId);
		expect(task?.status).toBe("completed");
	});

	it("fires onComplete callback when promise rejects", async () => {
		const taskId = Snowflake.next();
		const { promise, reject } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		let completed = false;

		registry.register(taskId, {
			id: taskId,
			status: "running",
			agent: "test-agent",
			description: "Test task",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise,
		});

		registry.onComplete(taskId, () => {
			completed = true;
		});

		reject(new Error("Test error"));

		try {
			await promise;
		} catch {
			// Expected
		}

		// Allow microtask queue to process
		await Promise.resolve();

		expect(completed).toBe(true);

		const task = registry.get(taskId);
		expect(task?.status).toBe("failed");
		expect(task?.error).toBe("Test error");
	});

	it("cleanup removes completed tasks", async () => {
		const taskId1 = Snowflake.next();
		const taskId2 = Snowflake.next();
		const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();

		registry.register(taskId1, {
			id: taskId1,
			status: "completed",
			agent: "test-agent",
			description: "Completed task",
			createdAt: Date.now(),
			completedAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise: promise1,
		});

		registry.register(taskId2, {
			id: taskId2,
			status: "running",
			agent: "test-agent",
			description: "Running task",
			createdAt: Date.now(),
			progress: [],
			abortController: new AbortController(),
			promise: promise2,
		});

		registry.cleanup();

		expect(registry.get(taskId1)).toBeUndefined();
		expect(registry.get(taskId2)).toBeDefined();

		resolve1({ content: [{ type: "text", text: "done" }] });
		resolve2({ content: [{ type: "text", text: "done" }] });
	});
});
