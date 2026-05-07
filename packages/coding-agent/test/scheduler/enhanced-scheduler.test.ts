/**
 * Tests for enhanced scheduler features:
 * - schedule type expansion (cron/interval/once)
 * - task type (shell/agent)
 * - execution timeout
 * - recursion prevention
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SchedulerEngine } from "../../src/scheduler/engine";
import { executeScheduledCommand } from "../../src/scheduler/executor";
import { SchedulerDbStorage } from "../../src/scheduler/storage";
import { parseSchedule, type ScheduledTask } from "../../src/scheduler/types";

describe("parseSchedule", () => {
	it("parses cron expressions", () => {
		const result = parseSchedule("0 9 * * *");
		expect(result.type).toBe("cron");
		expect(result.schedule).toBe("0 9 * * *");
		expect(result.error).toBeUndefined();
	});

	it("parses interval expressions", () => {
		const result = parseSchedule("5m");
		expect(result.type).toBe("interval");
		expect(result.schedule).toBe("5m");
		expect(result.intervalMs).toBe(300_000);
		expect(result.error).toBeUndefined();
	});

	it("parses relative time (one-shot)", () => {
		const before = Date.now();
		const result = parseSchedule("+30m");
		const after = Date.now();
		expect(result.type).toBe("once");
		expect(result.schedule).toBe("+30m");
		expect(result.nextRunAt).toBeGreaterThanOrEqual(before + 1_800_000);
		expect(result.nextRunAt).toBeLessThanOrEqual(after + 1_800_000);
		expect(result.error).toBeUndefined();
	});

	it("parses ISO timestamps (one-shot)", () => {
		const result = parseSchedule("2026-12-25T00:00:00Z");
		expect(result.type).toBe("once");
		expect(result.nextRunAt).toBe(new Date("2026-12-25T00:00:00Z").getTime());
	});

	it("rejects invalid schedules", () => {
		const result = parseSchedule("invalid garbage");
		expect(result.error).toBeDefined();
	});
});

describe("SchedulerDbStorage with new fields", () => {
	let dbPath: string;
	let storage: SchedulerDbStorage;

	beforeEach(() => {
		dbPath = path.join(os.tmpdir(), `scheduler-test-${Date.now()}.db`);
		storage = new SchedulerDbStorage(dbPath);
	});

	afterEach(() => {
		storage.close();
		try {
			fs.unlinkSync(dbPath);
		} catch {
			/* ignore */
		}
	});

	it("stores and retrieves scheduleType, taskType, timeoutMs", () => {
		const task = storage.addTask({
			name: "test-task",
			cron: "5m",
			command: "echo hello",
			scheduleType: "interval",
			taskType: "agent",
			timeoutMs: 60_000,
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
		});

		const retrieved = storage.getTask(task.id);
		expect(retrieved).toBeDefined();
		expect(retrieved!.scheduleType).toBe("interval");
		expect(retrieved!.taskType).toBe("agent");
		expect(retrieved!.timeoutMs).toBe(60_000);
	});

	it("defaults new fields when not provided", () => {
		const task = storage.addTask({
			name: "default-task",
			cron: "0 9 * * *",
			command: "echo hello",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
		});

		const retrieved = storage.getTask(task.id);
		expect(retrieved!.scheduleType).toBe("cron");
		expect(retrieved!.taskType).toBe("shell");
		expect(retrieved!.timeoutMs).toBe(30_000);
	});
});

describe("executeScheduledCommand", () => {
	it("executes shell commands", async () => {
		const result = await executeScheduledCommand("echo hello", { taskType: "shell" });
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("hello");
		expect(result.timedOut).toBe(false);
	});

	it("times out long-running commands", async () => {
		const start = Date.now();
		const result = await executeScheduledCommand("sleep 5", { timeoutMs: 100 });
		const elapsed = Date.now() - start;
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBe(124);
		expect(elapsed).toBeLessThan(1000);
	});

	it("captures stderr on failure", async () => {
		const result = await executeScheduledCommand("echo error >&2; exit 1", { taskType: "shell" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error");
		expect(result.timedOut).toBe(false);
	});
});

describe("SchedulerEngine interval scheduling", () => {
	let dbPath: string;
	let storage: SchedulerDbStorage;
	let engine: SchedulerEngine;
	let triggers: Array<{ task: ScheduledTask; execId: string }>;

	beforeEach(() => {
		dbPath = path.join(os.tmpdir(), `scheduler-engine-test-${Date.now()}.db`);
		storage = new SchedulerDbStorage(dbPath);
		triggers = [];
		engine = new SchedulerEngine({
			storage,
			onTrigger: async (task, execId) => {
				triggers.push({ task, execId });
			},
		});
	});

	afterEach(() => {
		engine.stop();
		storage.close();
		try {
			fs.unlinkSync(dbPath);
		} catch {
			/* ignore */
		}
	});

	it("triggers interval tasks", async () => {
		storage.addTask({
			name: "interval-task",
			cron: "100ms",
			command: "echo tick",
			scheduleType: "interval",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
		});

		engine.start();
		await Bun.sleep(350);
		engine.stop();

		expect(triggers.length).toBeGreaterThanOrEqual(2);
		expect(triggers[0]!.task.name).toBe("interval-task");
	});

	it("triggers one-shot tasks", async () => {
		storage.addTask({
			name: "oneshot-task",
			cron: "+50ms",
			command: "echo once",
			scheduleType: "once",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			nextRunAt: Date.now() + 50,
			runCount: 0,
			failCount: 0,
		});

		engine.start();
		await Bun.sleep(150);
		engine.stop();

		expect(triggers.length).toBe(1);
		expect(triggers[0]!.task.name).toBe("oneshot-task");
	});
});
