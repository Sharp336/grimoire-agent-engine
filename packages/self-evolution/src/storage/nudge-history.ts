/**
 * SQLite implementation of NudgeHistoryStore.
 */
import type { Database } from "bun:sqlite";
import type { NudgeRecord } from "../types";
import type { NudgeHistoryStore } from "./types";

export class SqliteNudgeHistoryStore implements NudgeHistoryStore {
	constructor(private db: Database) {}

	async insert(record: NudgeRecord): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO nudge_history (id, session_id, project, type, severity, message, suggestion, detected_at, dismissed_at, acknowledged)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			record.id,
			record.sessionId,
			record.project,
			record.type,
			record.severity,
			record.message,
			record.suggestion,
			record.detectedAt,
			record.dismissedAt ?? null,
			record.acknowledged ? 1 : 0,
		);
		stmt.finalize();
	}

	async listRecent(limit: number): Promise<NudgeRecord[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM nudge_history ORDER BY detected_at DESC LIMIT ?
		`);
		const rows = stmt.all(limit) as RawNudgeRow[];
		stmt.finalize();
		return rows.map(rowToNudgeRecord);
	}

	async listByType(type: string, limit: number): Promise<NudgeRecord[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM nudge_history WHERE type = ? ORDER BY detected_at DESC LIMIT ?
		`);
		const rows = stmt.all(type, limit) as RawNudgeRow[];
		stmt.finalize();
		return rows.map(rowToNudgeRecord);
	}

	async countByType(type: string, since: number): Promise<number> {
		const stmt = this.db.prepare(`
			SELECT COUNT(*) as c FROM nudge_history WHERE type = ? AND detected_at >= ?
		`);
		const row = stmt.get(type, since) as { c: number };
		stmt.finalize();
		return row.c;
	}

	async acknowledge(id: string): Promise<void> {
		const stmt = this.db.prepare(`
			UPDATE nudge_history SET acknowledged = 1 WHERE id = ?
		`);
		stmt.run(id);
		stmt.finalize();
	}

	async dismiss(id: string): Promise<void> {
		const stmt = this.db.prepare(`
			UPDATE nudge_history SET dismissed_at = ? WHERE id = ?
		`);
		stmt.run(Date.now(), id);
		stmt.finalize();
	}
}

interface RawNudgeRow {
	id: string;
	session_id: string;
	project: string;
	type: string;
	severity: string;
	message: string;
	suggestion: string;
	detected_at: number;
	dismissed_at: number | null;
	acknowledged: number;
}

function rowToNudgeRecord(row: RawNudgeRow): NudgeRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		project: row.project,
		type: row.type,
		severity: row.severity,
		message: row.message,
		suggestion: row.suggestion,
		detectedAt: row.detected_at,
		dismissedAt: row.dismissed_at ?? undefined,
		acknowledged: Boolean(row.acknowledged),
	};
}
