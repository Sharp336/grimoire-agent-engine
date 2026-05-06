/**
 * Episode storage with FTS5 full-text search.
 */
import type { Database } from "bun:sqlite";
import type { Episode } from "../types";
import type { EpisodeStore } from "./types";

export class SqliteEpisodeStore implements EpisodeStore {
	constructor(private db: Database) {}

	async insert(episode: Episode): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO episodes (
				id, session_id, cwd, user_prompt, timestamp, duration_ms,
				tool_call_count, error_count, had_recovery, completed_successfully,
				summary, tools_used, files_modified
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			episode.id,
			episode.sessionId,
			episode.cwd,
			episode.userPrompt,
			episode.timestamp,
			episode.durationMs,
			episode.toolCallCount,
			episode.errorCount,
			episode.hadRecovery ? 1 : 0,
			episode.completedSuccessfully ? 1 : 0,
			episode.summary,
			JSON.stringify(episode.toolsUsed),
			JSON.stringify(episode.filesModified),
		);
		stmt.finalize();
	}

	async listRecent(limit: number): Promise<Episode[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?
		`);
		const rows = stmt.all(limit) as RawEpisodeRow[];
		stmt.finalize();
		return rows.map(rowToEpisode);
	}

	async searchByKeyword(query: string, limit: number): Promise<Episode[]> {
		// Use FTS5 for full-text search, fallback to LIKE if FTS5 table is empty
		const countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM episodes_fts`);
		const countRow = countStmt.get() as { c: number };
		countStmt.finalize();

		if (countRow.c === 0) {
			// Fallback to LIKE search when FTS5 is empty
			const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`;
			const stmt = this.db.prepare(`
				SELECT * FROM episodes
				WHERE user_prompt LIKE ? OR summary LIKE ?
				ORDER BY timestamp DESC
				LIMIT ?
			`);
			const rows = stmt.all(pattern, pattern, limit) as RawEpisodeRow[];
			stmt.finalize();
			return rows.map(rowToEpisode);
		}

		// Escape FTS5 query special characters
		const safeQuery = query
			.replace(/"/g, '""')
			.replace(/'/g, "''")
			.replace(/\*/g, "")
			.replace(/-/g, " ")
			.split(/\s+/)
			.filter(Boolean)
			.join(" OR ");

		const stmt = this.db.prepare(`
			SELECT e.* FROM episodes e
			JOIN episodes_fts fts ON e.rowid = fts.rowid
			WHERE episodes_fts MATCH ?
			ORDER BY rank
			LIMIT ?
		`);
		const rows = stmt.all(safeQuery, limit) as RawEpisodeRow[];
		stmt.finalize();
		return rows.map(rowToEpisode);
	}

	async deleteOld(keepCount: number): Promise<number> {
		const countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM episodes`);
		const countRow = countStmt.get() as { c: number };
		countStmt.finalize();

		const toDelete = countRow.c - keepCount;
		if (toDelete <= 0) return 0;

		const stmt = this.db.prepare(`
			DELETE FROM episodes
			WHERE id IN (
				SELECT id FROM episodes ORDER BY timestamp ASC LIMIT ?
			)
		`);
		stmt.run(toDelete);
		stmt.finalize();
		return toDelete;
	}

	async count(): Promise<number> {
		const stmt = this.db.prepare(`SELECT COUNT(*) as c FROM episodes`);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}
}

interface RawEpisodeRow {
	id: string;
	session_id: string;
	cwd: string;
	user_prompt: string;
	timestamp: number;
	duration_ms: number;
	tool_call_count: number;
	error_count: number;
	had_recovery: number;
	completed_successfully: number;
	summary: string;
	tools_used: string;
	files_modified: string;
}

function rowToEpisode(row: RawEpisodeRow): Episode {
	return {
		id: row.id,
		sessionId: row.session_id,
		cwd: row.cwd,
		userPrompt: row.user_prompt,
		timestamp: row.timestamp,
		durationMs: row.duration_ms,
		toolCallCount: row.tool_call_count,
		errorCount: row.error_count,
		hadRecovery: Boolean(row.had_recovery),
		completedSuccessfully: Boolean(row.completed_successfully),
		summary: row.summary,
		toolsUsed: safeJsonParse(row.tools_used, []),
		filesModified: safeJsonParse(row.files_modified, []),
	};
}

function safeJsonParse<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}
