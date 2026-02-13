import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AsyncTaskHandle } from "@oh-my-pi/pi-coding-agent/task/registry";
import { TaskRegistry } from "@oh-my-pi/pi-coding-agent/task/registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ListTasksTool } from "@oh-my-pi/pi-coding-agent/tools/list-tasks";

function createTestSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function createMockTask(overrides: Partial<AsyncTaskHandle> = {}): AsyncTaskHandle {
	const id = overrides.id ?? "task_123";
	const status = overrides.status ?? "running";
	const agent = overrides.agent ?? "developer";
	const description = overrides.description ?? "Test task";
	const createdAt = overrides.createdAt ?? Date.now();
	const abortController = overrides.abortController ?? new AbortController();
	const promise = overrides.promise ?? Promise.resolve({} as any);

	return {
		id,
		status,
		agent,
		description,
		createdAt,
		abortController,
		promise,
		progress: [],
	};
}

describe("ListTasksTool", () => {
	it("returns empty list when no tasks", async () => {
		const session = createTestSession();
		const registry = new TaskRegistry();
		const tool = new ListTasksTool(session, registry);

		const result = await tool.execute("call_1", { include_completed: true });

		expect(result.details?.taskCount).toBe(0);
		expect(result.details?.runningCount).toBe(0);
		expect(result.details?.completedCount).toBe(0);
		expect(result.details?.summary).toContain("No tasks");
	});

	it("lists running tasks", async () => {
		const session = createTestSession();
		const registry = new TaskRegistry();

		const task = createMockTask({
			id: "task_abc",
			status: "running",
			description: "Running operation",
			agent: "explore",
		});

		registry.register(task.id, task);
		const tool = new ListTasksTool(session, registry);

		const result = await tool.execute("call_1", { include_completed: true });

		expect(result.details?.taskCount).toBe(1);
		expect(result.details?.runningCount).toBe(1);
		expect(result.details?.completedCount).toBe(0);
		expect(result.details?.summary).toContain("task_abc");
		expect(result.details?.summary).toContain("Running operation");
		expect(result.details?.summary).toContain("explore");
	});

	it("includes completed tasks by default", async () => {
		const session = createTestSession();
		const registry = new TaskRegistry();

		const runningTask = createMockTask({
			id: "task_running",
			status: "running",
			description: "Still running",
		});

		const completedTask = createMockTask({
			id: "task_completed",
			status: "completed",
			description: "Already done",
		});

		registry.register(runningTask.id, runningTask);
		registry.register(completedTask.id, completedTask);

		const tool = new ListTasksTool(session, registry);
		const result = await tool.execute("call_1", { include_completed: true });

		expect(result.details?.taskCount).toBe(2);
		expect(result.details?.runningCount).toBe(1);
		expect(result.details?.completedCount).toBe(1);
		expect(result.details?.summary).toContain("task_running");
		expect(result.details?.summary).toContain("task_completed");
	});

	it("filters completed tasks when include_completed is false", async () => {
		const session = createTestSession();
		const registry = new TaskRegistry();

		const runningTask = createMockTask({
			id: "task_running",
			status: "running",
			description: "Still running",
		});

		const completedTask = createMockTask({
			id: "task_completed",
			status: "completed",
			description: "Already done",
		});

		const failedTask = createMockTask({
			id: "task_failed",
			status: "failed",
			description: "Failed",
		});

		registry.register(runningTask.id, runningTask);
		registry.register(completedTask.id, completedTask);
		registry.register(failedTask.id, failedTask);

		const tool = new ListTasksTool(session, registry);
		const result = await tool.execute("call_1", { include_completed: false });

		expect(result.details?.taskCount).toBe(1);
		expect(result.details?.runningCount).toBe(1);
		expect(result.details?.completedCount).toBe(2);
		expect(result.details?.summary).toContain("task_running");
		expect(result.details?.summary).not.toContain("task_completed");
		expect(result.details?.summary).not.toContain("task_failed");
	});

	it("shows no running tasks message when include_completed is false and only completed tasks exist", async () => {
		const session = createTestSession();
		const registry = new TaskRegistry();

		const completedTask = createMockTask({
			id: "task_completed",
			status: "completed",
		});

		registry.register(completedTask.id, completedTask);
		const tool = new ListTasksTool(session, registry);

		const result = await tool.execute("call_1", { include_completed: false });

		expect(result.details?.taskCount).toBe(0);
		expect(result.details?.summary).toContain("No running tasks");
	});
});
