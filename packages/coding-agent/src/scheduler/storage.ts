/**
 * SQLite storage layer for the persistent cron scheduler.
 */
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	generateExecutionId,
	generateTaskId,
	getSchedulerDbPath,
	type ScheduledTask,
	type SchedulerStorage,
	type TaskExecution,
} from "./types";

// ---------------------------------------------------------------------------
// DB row shapes (snake_case)
// ---------------------------------------------------------------------------

type TaskRow = {
	id: string;
	name: string;
	description: string | null;
	cron: string;
	command: string;
	status: string;
	created_at: number;
	updated_at: number;
	last_run_at: number | null;
	next_run_at: number | null;
	run_count: number;
	fail_count: number;
};

type ExecutionRow = {
	id: string;
	task_id: string;
	started_at: number;
	ended_at: number | null;
	exit_code: number | null;
	output: string | null;
	stderr: string | null;
	status: string;
};

// ---------------------------------------------------------------------------
// Field allow-lists for dynamic updates
// ---------------------------------------------------------------------------

const TASK_UPDATE_FIELDS = new Set<string>([
	"name",
	"description",
	"cron",
	"command",
	"status",
	"createdAt",
	"updatedAt",
	"lastRunAt",
	"nextRunAt",
	"runCount",
	"failCount",
]);

const EXECUTION_UPDATE_FIELDS = new Set<string>([
	"taskId",
	"startedAt",
	"endedAt",
	"exitCode",
	"output",
	"stderr",
	"status",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTask(row: TaskRow): ScheduledTask {
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? undefined,
		cron: row.cron,
		command: row.command,
		status: row.status as ScheduledTask["status"],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastRunAt: row.last_run_at ?? undefined,
		nextRunAt: row.next_run_at ?? undefined,
		runCount: row.run_count,
		failCount: row.fail_count,
	};
}

function toExecution(row: ExecutionRow): TaskExecution {
	return {
		id: row.id,
		taskId: row.task_id,
		startedAt: row.started_at,
		endedAt: row.ended_at ?? undefined,
		exitCode: row.exit_code ?? undefined,
		output: row.output ?? undefined,
		stderr: row.stderr ?? undefined,
		status: row.status as TaskExecution["status"],
	};
}

function camelToSnake(str: string): string {
	return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function buildDynamicUpdate(
	updates: Record<string, unknown>,
	allowedFields: Set<string>,
	alwaysSet?: Record<string, unknown>,
): { sql: string; values: SQLQueryBindings[] } | undefined {
	const entries = Object.entries(updates).filter(([key]) => key !== "id" && allowedFields.has(key));
	if (entries.length === 0 && (!alwaysSet || Object.keys(alwaysSet).length === 0)) {
		return undefined;
	}

	const setClauses: string[] = [];
	const values: SQLQueryBindings[] = [];

	for (const [key, value] of entries) {
		setClauses.push(`${camelToSnake(key)} = ?`);
		values.push((value === undefined ? null : value) as SQLQueryBindings);
	}

	if (alwaysSet) {
		for (const [key, value] of Object.entries(alwaysSet)) {
			setClauses.push(`${camelToSnake(key)} = ?`);
			values.push(value as SQLQueryBindings);
		}
	}

	return { sql: setClauses.join(", "), values };
}

// ---------------------------------------------------------------------------
// Storage implementation
// ---------------------------------------------------------------------------

export class SchedulerDbStorage implements SchedulerStorage {
	#db: Database;

	// Prepared statements
	#insertTaskStmt: Statement;
	#getTaskStmt: Statement;
	#getTaskByNameStmt: Statement;
	#listTasksStmt: Statement;
	#deleteTaskStmt: Statement;
	#insertExecutionStmt: Statement;
	#getExecutionsStmt: Statement;

	constructor(dbPath: string = getSchedulerDbPath()) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });

		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec("PRAGMA foreign_keys = ON;");
		this.#db.exec("PRAGMA busy_timeout = 5000;");

		this.#initSchema();

		this.#insertTaskStmt = this.#db.prepare(`
			INSERT INTO tasks (
				id, name, description, cron, command, status,
				created_at, updated_at, last_run_at, next_run_at,
				run_count, fail_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.#getTaskStmt = this.#db.prepare("SELECT * FROM tasks WHERE id = ?");
		this.#getTaskByNameStmt = this.#db.prepare("SELECT * FROM tasks WHERE name = ?");
		this.#listTasksStmt = this.#db.prepare("SELECT * FROM tasks ORDER BY created_at DESC");
		this.#deleteTaskStmt = this.#db.prepare("DELETE FROM tasks WHERE id = ?");

		this.#insertExecutionStmt = this.#db.prepare(`
			INSERT INTO executions (
				id, task_id, started_at, ended_at,
				exit_code, output, stderr, status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.#getExecutionsStmt = this.#db.prepare(
			"SELECT * FROM executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?",
		);

		logger.debug("SchedulerDbStorage initialized", { path: dbPath });
	}

	#initSchema(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				description TEXT,
				cron TEXT NOT NULL,
				command TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'disabled')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_run_at INTEGER,
				next_run_at INTEGER,
				run_count INTEGER NOT NULL DEFAULT 0,
				fail_count INTEGER NOT NULL DEFAULT 0
			)
		`);

		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS executions (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				exit_code INTEGER,
				output TEXT,
				stderr TEXT,
				status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failure')),
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
			)
		`);

		this.#db.exec("CREATE INDEX IF NOT EXISTS idx_executions_task_id ON executions(task_id)");
		this.#db.exec("CREATE INDEX IF NOT EXISTS idx_executions_started_at ON executions(started_at DESC)");
	}

	addTask(task: Omit<ScheduledTask, "id">): ScheduledTask {
		const id = generateTaskId();
		const now = Date.now();
		this.#insertTaskStmt.run(
			id,
			task.name,
			task.description ?? null,
			task.cron,
			task.command,
			task.status,
			task.createdAt ?? now,
			task.updatedAt ?? now,
			task.lastRunAt ?? null,
			task.nextRunAt ?? null,
			task.runCount ?? 0,
			task.failCount ?? 0,
		);
		return this.getTask(id)!;
	}

	getTask(id: string): ScheduledTask | undefined {
		const row = this.#getTaskStmt.get(id) as TaskRow | undefined;
		return row ? toTask(row) : undefined;
	}

	getTaskByName(name: string): ScheduledTask | undefined {
		const row = this.#getTaskByNameStmt.get(name) as TaskRow | undefined;
		return row ? toTask(row) : undefined;
	}

	listTasks(): ScheduledTask[] {
		const rows = this.#listTasksStmt.all() as TaskRow[];
		return rows.map(toTask);
	}

	updateTask(id: string, updates: Partial<ScheduledTask>): void {
		const built = buildDynamicUpdate(updates, TASK_UPDATE_FIELDS, { updatedAt: Date.now() });
		if (!built) return;

		const sql = `UPDATE tasks SET ${built.sql} WHERE id = ?`;
		const params: SQLQueryBindings[] = [...built.values, id];
		this.#db.prepare(sql).run(...params);
	}

	deleteTask(id: string): void {
		this.#deleteTaskStmt.run(id);
	}

	recordExecution(exec: Omit<TaskExecution, "id">): TaskExecution {
		const id = generateExecutionId();
		this.#insertExecutionStmt.run(
			id,
			exec.taskId,
			exec.startedAt,
			exec.endedAt ?? null,
			exec.exitCode ?? null,
			exec.output ?? null,
			exec.stderr ?? null,
			exec.status,
		);
		return this.#getExecution(id)!;
	}

	updateExecution(id: string, updates: Partial<TaskExecution>): void {
		const built = buildDynamicUpdate(updates, EXECUTION_UPDATE_FIELDS);
		if (!built) return;

		const sql = `UPDATE executions SET ${built.sql} WHERE id = ?`;
		const params: SQLQueryBindings[] = [...built.values, id];
		this.#db.prepare(sql).run(...params);
	}

	getExecutions(taskId: string, limit?: number): TaskExecution[] {
		const safeLimit = Number.isFinite(limit) && limit! > 0 ? limit! : 1_000_000;
		const rows = this.#getExecutionsStmt.all(taskId, safeLimit) as ExecutionRow[];
		return rows.map(toExecution);
	}

	close(): void {
		this.#db.close();
	}

	#getExecution(id: string): TaskExecution | undefined {
		const row = this.#db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecutionRow | undefined;
		return row ? toExecution(row) : undefined;
	}
}
