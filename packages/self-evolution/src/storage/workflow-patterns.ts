/**
 * SQLite implementation of WorkflowPatternStore.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import type { WorkflowPattern } from "../types";
import type { WorkflowPatternStore } from "./types";

interface RawWorkflowRow {
	id: string;
	intent: string;
	tool_sequence: string;
	occurrence_count: number;
	avg_quality_score: number | null;
	last_seen_at: number;
}

function rowToPattern(row: RawWorkflowRow): WorkflowPattern {
	return {
		id: row.id,
		intent: row.intent as WorkflowPattern["intent"],
		toolSequence: JSON.parse(row.tool_sequence) as string[],
		occurrenceCount: row.occurrence_count,
		avgQualityScore: row.avg_quality_score ?? 0,
		lastSeenAt: row.last_seen_at,
	};
}

export class SqliteWorkflowPatternStore implements WorkflowPatternStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async upsert(pattern: WorkflowPattern): Promise<void> {
		const selectStmt = this.#db.prepare(
			"SELECT occurrence_count, avg_quality_score FROM workflow_patterns WHERE id = ?",
		);
		const existing = selectStmt.get(pattern.id) as
			| { occurrence_count: number; avg_quality_score: number | null }
			| undefined;
		selectStmt.finalize();

		if (existing) {
			const oldCount = existing.occurrence_count;
			const oldAvg = existing.avg_quality_score ?? 0;
			const newCount = oldCount + pattern.occurrenceCount;
			const newAvg =
				newCount > 0 ? (oldAvg * oldCount + pattern.avgQualityScore * pattern.occurrenceCount) / newCount : oldAvg;

			const stmt = this.#db.prepare(`
				UPDATE workflow_patterns
				SET occurrence_count = ?,
				    avg_quality_score = ?,
				    last_seen_at = ?
				WHERE id = ?
			`);
			stmt.run(newCount, newAvg, Date.now(), pattern.id);
			stmt.finalize();

			logger.debug("Workflow pattern updated", {
				id: pattern.id,
				intent: pattern.intent,
				occurrenceCount: newCount,
				avgQualityScore: newAvg,
			});
		} else {
			const stmt = this.#db.prepare(`
				INSERT INTO workflow_patterns (id, intent, tool_sequence, occurrence_count, avg_quality_score, last_seen_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`);
			stmt.run(
				pattern.id,
				pattern.intent,
				JSON.stringify(pattern.toolSequence),
				pattern.occurrenceCount,
				pattern.avgQualityScore,
				pattern.lastSeenAt,
			);
			stmt.finalize();

			logger.debug("Workflow pattern inserted", {
				id: pattern.id,
				intent: pattern.intent,
				occurrenceCount: pattern.occurrenceCount,
			});
		}
	}

	async getByIntent(intent: string, limit: number): Promise<WorkflowPattern[]> {
		const stmt = this.#db.prepare(`
			SELECT * FROM workflow_patterns WHERE intent = ? ORDER BY occurrence_count DESC LIMIT ?
		`);
		const rows = stmt.all(intent, limit) as RawWorkflowRow[];
		stmt.finalize();
		return rows.map(rowToPattern);
	}

	async getById(id: string): Promise<WorkflowPattern | undefined> {
		const stmt = this.#db.prepare(`SELECT * FROM workflow_patterns WHERE id = ?`);
		const row = stmt.get(id) as RawWorkflowRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToPattern(row);
	}

	async listAll(): Promise<WorkflowPattern[]> {
		const stmt = this.#db.prepare(`
			SELECT * FROM workflow_patterns ORDER BY occurrence_count DESC
		`);
		const rows = stmt.all() as RawWorkflowRow[];
		stmt.finalize();
		return rows.map(rowToPattern);
	}
}
