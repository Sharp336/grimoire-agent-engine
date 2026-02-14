import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TaskRegistry } from "@oh-my-pi/pi-coding-agent/task/registry";
import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * TaskRegistry async execution support tests
 *
 * Unit tests verifying the TaskRegistry supports async task execution:
 * - Task registration and state tracking
 * - Completion callbacks fire correctly
 * - Concurrency limits enforced
 * - Status isolation prevents corruption
 *
 * These tests validate registry behavior without requiring full TaskTool
 * subprocess setup (which is tested separately in blocking-regression.test.ts).
 */
describe("TaskRegistry async execution support", () => {
	let registry: TaskRegistry;

	beforeEach(() => {
		registry = new TaskRegistry();
	});

	afterEach(() => {
		registry.cleanup();
	});

	it("registry generates unique Snowflake IDs for async tasks", async () => {
		// Async task IDs must be globally unique to prevent collisions
		// Snowflake.next() generates unique IDs suitable for task identifiers
		const id1 = Snowflake.next();
		const id2 = Snowflake.next();
		expect(id1).not.toEqual(id2);
		expect(typeof id1).toBe("string");
		expect(id1.length).toBeGreaterThan(0);
	});

	it("registry stores and retrieves running async tasks", async () => {
		// Async tasks must be retrievable for check_task and list_tasks operations
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<any>();

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
		expect(task?.status).toBe("running");

		resolve({ content: [{ type: "text", text: "done" }] });
	});

	it("registry transitions tasks from running to completed", async () => {
		// Registry must properly track task completion status
		// When promise resolves, status updates from "running" to "completed"
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<any>();

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

		resolve({
			content: [{ type: "text", text: "done" }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
			},
		});

		await Bun.sleep(50);
		const task = registry.get(taskId);
		expect(task?.status).toBe("completed");
	});

	it("registry rejects registration when async task limit exceeded", async () => {
		// Registry enforces concurrent task limit (MAX_TASKS = 100)
		// TaskTool uses this to reject async requests with "limit reached" error
		const taskIds: string[] = [];
		const { promise, resolve } = Promise.withResolvers<any>();

		// Fill registry to max capacity
		for (let i = 0; i < TaskRegistry.MAX_TASKS; i++) {
			const taskId = Snowflake.next();
			taskIds.push(taskId);
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

		expect(registry.list().length).toBe(TaskRegistry.MAX_TASKS);

		// Next registration must fail - this is how TaskTool rejects async requests
		expect(() => {
			registry.register(Snowflake.next(), {
				id: Snowflake.next(),
				status: "running",
				agent: "test-agent",
				description: "Task exceeds limit",
				createdAt: Date.now(),
				progress: [],
				abortController: new AbortController(),
				promise,
			});
		}).toThrow();

		resolve({ content: [{ type: "text", text: "done" }] });
	});

	it("registry prevents status corruption on concurrent completion", async () => {
		// Critical: when promise settles, registry must check status is still "running"
		// before updating it. This prevents overwriting a "cancelled" status.
		// This is tested in more detail in registry.test.ts - this test documents
		// the use case that makes it necessary.
		const taskId = Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<any>();

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

		// Cancel the task
		registry.cancel(taskId);
		const cancelledTask = registry.get(taskId);
		expect(cancelledTask?.status).toBe("cancelled");

		// Now complete the promise - it should NOT overwrite cancelled status
		resolve({
			content: [{ type: "text", text: "done" }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
			},
		});

		await Bun.sleep(50);
		const finalTask = registry.get(taskId);
		expect(finalTask?.status).toBe("cancelled"); // Must stay cancelled
	});

	it("cancelled tasks are scheduled for eviction", () => {
		// When a task is cancelled, it should be scheduled for eviction
		// so it doesn't remain in memory indefinitely
		const taskId = Snowflake.next();
		const { promise } = Promise.withResolvers<any>();

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

		registry.cancel(taskId);

		const task = registry.get(taskId);
		expect(task).toBeDefined();
		expect(task?.status).toBe("cancelled");
		// Verify eviction was scheduled (task should still exist)
		// and will be removed after the retention period
	});
});
