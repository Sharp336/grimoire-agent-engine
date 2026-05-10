/**
 * Core types for the persistent cron scheduler.
 */

export type TaskStatus = "active" | "paused" | "disabled";

export type ScheduleType = "cron" | "interval" | "once";

export type TaskType = "shell" | "agent";

export interface ScheduledTask {
	id: string;
	name: string;
	description?: string;
	cron: string;
	command: string;
	status: TaskStatus;
	scheduleType?: "cron" | "interval" | "once";
	taskType?: "shell" | "agent";
	timeoutMs?: number;
	createdAt: number;
	updatedAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
	runCount: number;
	failCount: number;
}

export interface TaskExecution {
	id: string;
	taskId: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	output?: string;
	stderr?: string;
	status: "running" | "success" | "failure";
}

export interface SchedulerStorage {
	addTask(task: Omit<ScheduledTask, "id">): ScheduledTask;
	getTask(id: string): ScheduledTask | undefined;
	getTaskByName(name: string): ScheduledTask | undefined;
	listTasks(): ScheduledTask[];
	updateTask(id: string, updates: Partial<ScheduledTask>): void;
	deleteTask(id: string): void;
	recordExecution(exec: Omit<TaskExecution, "id">): TaskExecution;
	updateExecution(id: string, updates: Partial<TaskExecution>): void;
	getExecutions(taskId: string, limit?: number): TaskExecution[];
}

export interface EngineOptions {
	storage: SchedulerStorage;
	onTrigger: (task: ScheduledTask, executionId: string) => Promise<void>;
}

export interface DaemonOptions {
	dbPath: string;
	ompBinary: string;
	foreground?: boolean;
}

export interface DaemonStatus {
	running: boolean;
	pid?: number;
	taskCount: number;
	startedAt?: number;
}

export type ScheduleAction = "add" | "diagnose" | "list" | "remove" | "run" | "enable" | "disable" | "logs";

export type DaemonAction = "start" | "stop" | "status" | "restart";

export const SCHEDULER_DB_NAME = "scheduler.db";
export const SCHEDULER_PID_FILE = "scheduler.pid";
export const SCHEDULER_LOG_FILE = "scheduler.log";

export function getSchedulerDir(): string {
	const os = require("node:os");
	const path = require("node:path");
	return path.join(os.homedir(), ".omp");
}

export function getSchedulerDbPath(): string {
	const path = require("node:path");
	return path.join(getSchedulerDir(), SCHEDULER_DB_NAME);
}

export function getSchedulerPidPath(): string {
	const path = require("node:path");
	return path.join(getSchedulerDir(), SCHEDULER_PID_FILE);
}

export function getSchedulerLogPath(): string {
	const path = require("node:path");
	return path.join(getSchedulerDir(), SCHEDULER_LOG_FILE);
}

export function generateTaskId(): string {
	return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateExecutionId(): string {
	return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface ParsedSchedule {
	type: ScheduleType;
	schedule: string;
	intervalMs?: number;
	nextRunAt?: number;
	error?: string;
}

function parseRelativeTime(input: string): number | undefined {
	const match = input.match(/^\+(\d+)(ms|s|m|h|d)$/);
	if (!match) return undefined;
	const value = Number.parseInt(match[1]!, 10);
	const unit = match[2]!;
	const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return value * multipliers[unit]!;
}

function parseInterval(input: string): number | undefined {
	const match = input.match(/^(\d+)(ms|s|m|h|d)$/);
	if (!match) return undefined;
	const value = Number.parseInt(match[1]!, 10);
	const unit = match[2]!;
	const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return value * multipliers[unit]!;
}

function parseIsoTimestamp(input: string): number | undefined {
	// Require at least a year-month-day structure (e.g., 2026-05-08 or 2026/05/08)
	if (!/\d{4}[-/]\d{2}[-/]\d{2}/.test(input)) return undefined;
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return undefined;
	return d.getTime();
}

export function parseSchedule(input: string): ParsedSchedule {
	const trimmed = input.trim();

	// Relative time: +5m, +1h, +2d
	const relativeMs = parseRelativeTime(trimmed);
	if (relativeMs !== undefined) {
		return { type: "once", schedule: trimmed, nextRunAt: Date.now() + relativeMs };
	}

	// Interval: 5m, 1h (not starting with +)
	const intervalMs = parseInterval(trimmed);
	if (intervalMs !== undefined) {
		return { type: "interval", schedule: trimmed, intervalMs };
	}

	// ISO timestamp: 2026-05-08T09:00:00
	const ts = parseIsoTimestamp(trimmed);
	if (ts !== undefined) {
		return { type: "once", schedule: trimmed, nextRunAt: ts };
	}

	// Fall back to cron validation
	const cronValidation = validateCron(trimmed);
	if (cronValidation.valid) {
		return { type: "cron", schedule: trimmed };
	}

	return { type: "cron", schedule: trimmed, error: cronValidation.error };
}

export function validateCron(cron: string): { valid: boolean; error?: string } {
	try {
		if (!cron || cron.trim().length === 0) {
			return { valid: false, error: "Cron expression is empty" };
		}
		const { Cron } = require("croner");
		new Cron(cron, { maxIterations: 0 });
		return { valid: true };
	} catch (err) {
		return { valid: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function getNextRun(cron: string): Date | null {
	try {
		const { Cron } = require("croner");
		const job = new Cron(cron, { maxIterations: 0 });
		return job.nextRun() as Date | null;
	} catch {
		return null;
	}
}

export function getNextRuns(cron: string, count: number): Date[] {
	try {
		const { Cron } = require("croner");
		const job = new Cron(cron, { maxIterations: 0 });
		return job.nextRuns(count) as Date[];
	} catch {
		return [];
	}
}
export function isDaemonRunning(pidPath: string): boolean {
	const fs = require("node:fs");
	try {
		const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		if (Number.isNaN(pid)) return false;
		// Check if process exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readDaemonPid(pidPath: string): number | undefined {
	const fs = require("node:fs");
	try {
		const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		return Number.isNaN(pid) ? undefined : pid;
	} catch {
		return undefined;
	}
}

export function writeDaemonPid(pidPath: string, pid: number): void {
	const fs = require("node:fs");
	const path = require("node:path");
	const dir = path.dirname(pidPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(pidPath, String(pid), { flag: "w" });
}

export function clearDaemonPid(pidPath: string): void {
	const fs = require("node:fs");
	try {
		fs.unlinkSync(pidPath);
	} catch {
		// ignore
	}
}

export function stopDaemon(pid: number): boolean {
	try {
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

export async function waitForDaemonStop(pidPath: string, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isDaemonRunning(pidPath)) return true;
		await Bun.sleep(200);
	}
	return false;
}

export async function waitForDaemonStart(pidPath: string, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (isDaemonRunning(pidPath)) return true;
		await Bun.sleep(200);
	}
	return false;
}

export function formatTaskRow(task: ScheduledTask): string {
	const next = task.status === "active" && task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—";
	const last = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : "never";
	const typeLabel = task.taskType === "agent" ? "agent " : "shell ";
	return `${task.name.padEnd(18)} ${typeLabel.padEnd(6)} ${task.status.padEnd(10)} ${(task.scheduleType || "cron").padEnd(8)} ${task.cron.padEnd(18)} ${next.padEnd(20)} ${last}`;
}

export function formatExecutionRow(exec: TaskExecution): string {
	const duration = exec.endedAt && exec.startedAt ? `${((exec.endedAt - exec.startedAt) / 1000).toFixed(1)}s` : "—";
	return `${exec.id.slice(0, 16).padEnd(18)} ${exec.status.padEnd(8)} ${duration.padEnd(8)} ${exec.exitCode ?? "—"}`;
}

export function formatNextRuns(task: ScheduledTask, count = 3): string {
	if (task.status !== "active") return "(disabled)";
	if (task.scheduleType === "interval") return `every ${task.cron}`;
	if (task.scheduleType === "once") return task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "(past)";
	const runs = getNextRuns(task.cron, count);
	if (runs.length === 0) return "(invalid cron)";
	return runs.map(d => d.toLocaleString()).join(", ");
}
