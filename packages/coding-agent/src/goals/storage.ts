import { Database } from "bun:sqlite";
import * as path from "node:path";
import { getAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import type { GoalStatus, ThreadGoal } from "./types";
import { validateGoalObjective, validateTokenBudget } from "./validate";

export type GoalAccountMode = "active_only" | "active_status_only";

interface GoalRow {
	thread_id: string;
	goal_id: string;
	objective: string;
	status: GoalStatus;
	token_budget: number | null;
	tokens_used: number;
	time_used_seconds: number;
	created_at: number;
	updated_at: number;
}

function rowToGoal(row: GoalRow): ThreadGoal {
	return {
		threadId: row.thread_id,
		goalId: row.goal_id,
		objective: row.objective,
		status: row.status,
		tokenBudget: row.token_budget,
		tokensUsed: row.tokens_used,
		timeUsedSeconds: row.time_used_seconds,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function defaultGoalDbPath(): string {
	return path.join(getAgentDir(), "goals.sqlite");
}

export function openGoalDb(dbPath = defaultGoalDbPath()): Database {
	const db = new Database(dbPath);
	db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS thread_goals (
	thread_id TEXT PRIMARY KEY,
	goal_id TEXT NOT NULL,
	objective TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active','paused','budget_limited','complete')),
	token_budget INTEGER,
	tokens_used INTEGER NOT NULL DEFAULT 0,
	time_used_seconds INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`);
	return db;
}

export class GoalStorage {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	getGoal(threadId: string): ThreadGoal | null {
		const row = this.#db.prepare("SELECT * FROM thread_goals WHERE thread_id = ?").get(threadId) as
			| GoalRow
			| undefined;
		return row ? rowToGoal(row) : null;
	}

	insertGoal(threadId: string, objective: string, tokenBudget?: number | null): ThreadGoal {
		const now = Math.floor(Date.now() / 1000);
		const goalId = Snowflake.next();
		const normalizedObjective = validateGoalObjective(objective);
		const normalizedBudget = validateTokenBudget(tokenBudget);
		const result = this.#db
			.prepare(`
INSERT OR IGNORE INTO thread_goals (
	thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at, updated_at
) VALUES (?, ?, ?, 'active', ?, 0, 0, ?, ?)
`)
			.run(threadId, goalId, normalizedObjective, normalizedBudget, now, now);
		if (Number(result.changes ?? 0) === 0) {
			throw new Error("A goal already exists for this thread.");
		}
		const goal = this.getGoal(threadId);
		if (!goal) throw new Error("Failed to create goal.");
		return goal;
	}

	replaceGoal(threadId: string, objective: string, status: GoalStatus, tokenBudget?: number | null): ThreadGoal {
		const now = Math.floor(Date.now() / 1000);
		const goalId = Snowflake.next();
		const normalizedObjective = validateGoalObjective(objective);
		const normalizedBudget = validateTokenBudget(tokenBudget);
		this.#db
			.prepare(`
INSERT INTO thread_goals (
	thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
	goal_id = excluded.goal_id,
	objective = excluded.objective,
	status = excluded.status,
	token_budget = excluded.token_budget,
	tokens_used = 0,
	time_used_seconds = 0,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at
`)
			.run(threadId, goalId, normalizedObjective, status, normalizedBudget, now, now);
		const goal = this.getGoal(threadId);
		if (!goal) throw new Error("Failed to replace goal.");
		return goal;
	}

	updateGoal(
		threadId: string,
		update: { status?: GoalStatus; tokenBudget?: number | null; expectedGoalId?: string },
	): ThreadGoal | null {
		const current = this.getGoal(threadId);
		if (!current) return null;
		if (update.expectedGoalId && current.goalId !== update.expectedGoalId) return current;
		const nextStatus = update.status ?? current.status;
		const nextBudget =
			update.tokenBudget === undefined ? current.tokenBudget : validateTokenBudget(update.tokenBudget);
		const now = Math.floor(Date.now() / 1000);
		this.#db
			.prepare("UPDATE thread_goals SET status = ?, token_budget = ?, updated_at = ? WHERE thread_id = ?")
			.run(nextStatus, nextBudget, now, threadId);
		return this.getGoal(threadId);
	}

	accountUsage(
		threadId: string,
		deltaTokens: number,
		deltaSeconds: number,
		mode: GoalAccountMode,
		expectedGoalId?: string,
	): { outcome: "updated" | "unchanged"; goal: ThreadGoal | null } {
		const current = this.getGoal(threadId);
		if (!current) return { outcome: "unchanged", goal: null };
		if (expectedGoalId && current.goalId !== expectedGoalId) return { outcome: "unchanged", goal: current };
		if (current.status !== "active") return { outcome: "unchanged", goal: current };
		const tokensUsed = Math.max(0, current.tokensUsed + Math.max(0, Math.floor(deltaTokens)));
		const timeUsedSeconds = Math.max(0, current.timeUsedSeconds + Math.max(0, Math.floor(deltaSeconds)));
		const nextStatus =
			mode === "active_only" && current.tokenBudget !== null && tokensUsed >= current.tokenBudget
				? "budget_limited"
				: current.status;
		const now = Math.floor(Date.now() / 1000);
		this.#db
			.prepare(`
UPDATE thread_goals
SET tokens_used = ?, time_used_seconds = ?, status = ?, updated_at = ?
WHERE thread_id = ?
`)
			.run(tokensUsed, timeUsedSeconds, nextStatus, now, threadId);
		return { outcome: "updated", goal: this.getGoal(threadId) };
	}

	pauseActiveGoal(threadId: string): ThreadGoal | null {
		const current = this.getGoal(threadId);
		if (!current || current.status !== "active") return current;
		return this.updateGoal(threadId, { status: "paused" });
	}

	clearGoal(threadId: string): boolean {
		const result = this.#db.prepare("DELETE FROM thread_goals WHERE thread_id = ?").run(threadId);
		return Number(result.changes ?? 0) > 0;
	}
}
