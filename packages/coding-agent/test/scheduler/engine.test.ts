/**
 * Tests for SchedulerEngine.
 */
import { describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SchedulerEngine } from "../../src/scheduler/engine";
import { SchedulerDbStorage } from "../../src/scheduler/storage";

const TEST_DB_DIR = path.join("/tmp", `omp-engine-test-${Date.now()}`);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "engine.db");

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

describe("SchedulerEngine", () => {
	it("starts and loads active tasks", () => {
		const storage = createStorage();
		try {
			const task = storage.addTask({
				name: "active-task",
				cron: "0 8 * * *",
				command: "echo active",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			const onTrigger = mock(() => Promise.resolve());
			const engine = new SchedulerEngine({ storage, onTrigger });
			engine.start();

			expect(engine.getActiveTaskIds()).toContain(task.id);

			engine.stop();
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("does not load paused or disabled tasks", () => {
		const storage = createStorage();
		try {
			const active = storage.addTask({
				name: "a",
				cron: "0 8 * * *",
				command: "echo a",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});
			storage.addTask({
				name: "p",
				cron: "0 9 * * *",
				command: "echo p",
				status: "paused",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});
			storage.addTask({
				name: "d",
				cron: "0 10 * * *",
				command: "echo d",
				status: "disabled",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			const onTrigger = mock(() => Promise.resolve());
			const engine = new SchedulerEngine({ storage, onTrigger });
			engine.start();

			const ids = engine.getActiveTaskIds();
			expect(ids).toContain(active.id);
			expect(ids.length).toBe(1);

			engine.stop();
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("schedules a new task", () => {
		const storage = createStorage();
		try {
			const onTrigger = mock(() => Promise.resolve());
			const engine = new SchedulerEngine({ storage, onTrigger });
			engine.start();

			const task = storage.addTask({
				name: "new-task",
				cron: "0 11 * * *",
				command: "echo new",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			engine.schedule(task);
			expect(engine.getActiveTaskIds()).toContain(task.id);

			engine.stop();
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("unschedules a task", () => {
		const storage = createStorage();
		try {
			const task = storage.addTask({
				name: "remove-me",
				cron: "0 12 * * *",
				command: "echo rm",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			const onTrigger = mock(() => Promise.resolve());
			const engine = new SchedulerEngine({ storage, onTrigger });
			engine.start();
			expect(engine.getActiveTaskIds()).toContain(task.id);

			engine.unschedule(task.id);
			expect(engine.getActiveTaskIds()).not.toContain(task.id);

			engine.stop();
		} finally {
			storage.close();
			cleanup();
		}
	});

	it("reloads to pick up task changes", () => {
		const storage = createStorage();
		try {
			const task = storage.addTask({
				name: "reload-test",
				cron: "0 13 * * *",
				command: "echo old",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});

			const onTrigger = mock(() => Promise.resolve());
			const engine = new SchedulerEngine({ storage, onTrigger });
			engine.start();

			storage.updateTask(task.id, { cron: "0 14 * * *" });
			engine.reload();

			expect(engine.getActiveTaskIds()).toContain(task.id);

			engine.stop();
		} finally {
			storage.close();
			cleanup();
		}
	});
});

/**
 * Tests for scheduler/daemon.ts (not the CLI command).
 */
import { SchedulerDaemon } from "../../src/scheduler/daemon";

describe("SchedulerDaemon", () => {
	it("reports correct status when not started", () => {
		const daemon = new SchedulerDaemon({
			dbPath: TEST_DB_PATH,
			ompBinary: "omp",
			foreground: true,
		});

		const status = daemon.getStatus();
		expect(status.running).toBe(false);
		expect(status.taskCount).toBe(0);
	});
});

/**
 * Tests for scheduler types helper functions.
 */
import { getNextRun, isDaemonRunning, validateCron } from "../../src/scheduler/types";

describe("Scheduler type helpers", () => {
	it("validates correct cron expressions", () => {
		expect(validateCron("0 9 * * *").valid).toBe(true);
		expect(validateCron("* * * * *").valid).toBe(true);
	});

	it("rejects invalid cron expressions", () => {
		expect(validateCron("").valid).toBe(false);
		expect(validateCron("invalid").valid).toBe(false);
	});

	it("computes next run for valid cron", () => {
		const next = getNextRun("0 0 1 1 *");
		expect(next).toBeDefined();
		expect(next instanceof Date).toBe(true);
	});

	it("returns null for invalid cron next run", () => {
		expect(getNextRun("invalid")).toBeNull();
	});

	it("detects non-running daemon", () => {
		expect(isDaemonRunning("/tmp/nonexistent-pid-file-12345")).toBe(false);
	});
});
