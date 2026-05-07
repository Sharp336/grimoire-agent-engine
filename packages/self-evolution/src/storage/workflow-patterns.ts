/**
 * SQLite implementation of WorkflowPatternStore.
 */
import type { Database } from "bun:sqlite";
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
	constructor(private db: Database) {}

	async upsert(pattern: WorkflowPattern): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO workflow_patterns (id, intent, tool_sequence, occurrence_count, avg_quality_score, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				occurrence_count = workflow_patterns.occurrence_count + excluded.occurrence_count,
				avg_quality_score = excluded.avg_quality_score,
				last_seen_at = excluded.last_seen_at
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
	}

	async getByIntent(intent: string, limit: number): Promise<WorkflowPattern[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM workflow_patterns WHERE intent = ? ORDER BY occurrence_count DESC LIMIT ?
		`);
		const rows = stmt.all(intent, limit) as RawWorkflowRow[];
		stmt.finalize();
		return rows.map(rowToPattern);
	}

	async getById(id: string): Promise<WorkflowPattern | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM workflow_patterns WHERE id = ?`);
		const row = stmt.get(id) as RawWorkflowRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToPattern(row);
	}

	async listAll(): Promise<WorkflowPattern[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM workflow_patterns ORDER BY occurrence_count DESC
		`);
		const rows = stmt.all() as RawWorkflowRow[];
		stmt.finalize();
		return rows.map(rowToPattern);
	}
}
