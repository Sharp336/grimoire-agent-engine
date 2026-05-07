/**
 * Tests for SchedulerDbStorage.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SchedulerDbStorage } from "../../src/scheduler/storage";

describe("SchedulerDbStorage", () => {
	const TEST_DB_DIR = path.join("/tmp", `omp-scheduler-test-${Date.now()}`);
	const TEST_DB_PATH = path.join(TEST_DB_DIR, "scheduler.db");

	function createStorage(): SchedulerDbStorage {
		fs.mkdirSync(TEST_DB_DIR, { recursive: true });
		return new SchedulerDbStorage(TEST_DB_PATH);
	}

	function cleanup(): void {
		try {
			fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}

	it("adds and retrieves a task", () => {
		const storage = createStorage();
		try {
			const task = storage.addTask({
				name: "test-task",
				cron: "0 9 * * *",
				command: "echo hello",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			expect(task.id).toBeDefined();
			expect(task.name).toBe("test-task");

			const retrieved = storage.getTask(task.id);
			expect(retrieved).toBeDefined();
			expect(retrieved!.name).toBe("test-task");
			expect(retrieved!.cron).toBe("0 9 * * *");
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("gets task by name", () => {
		const storage = createStorage();
		try {
			storage.addTask({
				name: "by-name",
				cron: "0 10 * * *",
				command: "echo bye",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			const found = storage.getTaskByName("by-name");
			expect(found).toBeDefined();
			expect(found!.command).toBe("echo bye");

			const missing = storage.getTaskByName("nonexistent");
			expect(missing).toBeUndefined();
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("lists tasks ordered by created_at desc", () => {
		const storage = createStorage();
		try {
			storage.addTask({
				name: "first",
				cron: "0 1 * * *",
				command: "echo 1",
				status: "active",
				createdAt: 1000,
				updatedAt: 1000,
				runCount: 0,
				failCount: 0,
			});
			storage.addTask({
				name: "second",
				cron: "0 2 * * *",
				command: "echo 2",
				status: "active",
				createdAt: 2000,
				updatedAt: 2000,
				runCount: 0,
				failCount: 0,
			});

			const tasks = storage.listTasks();
			expect(tasks.length).toBe(2);
			expect(tasks[0].name).toBe("second");
			expect(tasks[1].name).toBe("first");
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("updates a task", () => {
		const storage = createStorage();
		try {
			const task = storage.addTask({
				name: "update-me",
				cron: "0 3 * * *",
				command: "echo old",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			storage.updateTask(task.id, { command: "echo new", runCount: 5 });

			const updated = storage.getTask(task.id);
			expect(updated!.command).toBe("echo new");
			expect(updated!.runCount).toBe(5);
			expect(updated!.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("deletes a task and cascades executions", () => {
		const storage = createStorage();
		try {
			const task = storage.addTask({
				name: "delete-me",
				cron: "0 4 * * *",
				command: "echo x",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			storage.recordExecution({
				taskId: task.id,
				startedAt: Date.now(),
				status: "success",
			});

			storage.deleteTask(task.id);

			expect(storage.getTask(task.id)).toBeUndefined();
			expect(storage.getExecutions(task.id).length).toBe(0);
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("records and retrieves executions", () => {
		const storage = createStorage();
		try {
			const task = storage.addTask({
				name: "exec-test",
				cron: "0 5 * * *",
				command: "echo e",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			const exec = storage.recordExecution({
				taskId: task.id,
				startedAt: 1000,
				status: "running",
			});

			expect(exec.id).toBeDefined();
			expect(exec.status).toBe("running");

			storage.updateExecution(exec.id, {
				endedAt: 2000,
				exitCode: 0,
				output: "hello",
				status: "success",
			});

			const executions = storage.getExecutions(task.id, 10);
			expect(executions.length).toBe(1);
			expect(executions[0].status).toBe("success");
			expect(executions[0].output).toBe("hello");
			expect(executions[0].endedAt).toBe(2000);
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("enforces unique task names", () => {
		const storage = createStorage();
		try {
			storage.addTask({
				name: "unique",
				cron: "0 6 * * *",
				command: "echo u",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			expect(() =>
				storage.addTask({
					name: "unique",
					cron: "0 7 * * *",
					command: "echo conflict",
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					runCount: 0,
					failCount: 0,
				}),
			).toThrow();
		} finally {
			storage.close();
			cleanup();
		}
	});
});
