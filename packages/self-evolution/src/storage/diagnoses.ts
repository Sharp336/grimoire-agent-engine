/**
 * Episode diagnosis storage — persists ToolChainDiagnosis for cross-session analysis.
 */
import type { Database } from "bun:sqlite";
import type { ToolChainDiagnosis } from "../types";
import type { EpisodeDiagnosisStore } from "./types";

interface RawDiagnosisRow {
	episode_id: string;
	read_failures_json: string;
	cascade_patterns_json: string;
	redundant_searches: number;
	slow_loop: number;
	tool_efficiency: number;
	dominant_error_tool: string | null;
	dominant_error_pattern: string | null;
	suggested_action: string;
	recorded_at: number;
}

export class SqliteEpisodeDiagnosisStore implements EpisodeDiagnosisStore {
	constructor(private db: Database) {}

	async insert(diagnosis: ToolChainDiagnosis): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO episode_diagnoses (
				episode_id, read_failures_json, cascade_patterns_json,
				redundant_searches, slow_loop, tool_efficiency,
				dominant_error_tool, dominant_error_pattern, suggested_action, recorded_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(episode_id) DO UPDATE SET
				read_failures_json = excluded.read_failures_json,
				cascade_patterns_json = excluded.cascade_patterns_json,
				redundant_searches = excluded.redundant_searches,
				slow_loop = excluded.slow_loop,
				tool_efficiency = excluded.tool_efficiency,
				dominant_error_tool = excluded.dominant_error_tool,
				dominant_error_pattern = excluded.dominant_error_pattern,
				suggested_action = excluded.suggested_action,
				recorded_at = excluded.recorded_at
		`);
		stmt.run(
			diagnosis.sessionId,
			JSON.stringify(diagnosis.readFailures),
			JSON.stringify(diagnosis.cascadePatterns),
			diagnosis.redundantSearches ? 1 : 0,
			diagnosis.slowLoop ? 1 : 0,
			diagnosis.toolEfficiency,
			diagnosis.dominantErrorTool ?? null,
			diagnosis.dominantErrorPattern ?? null,
			diagnosis.suggestedAction,
			Date.now(),
		);
		stmt.finalize();
	}

	async get(episodeId: string): Promise<ToolChainDiagnosis | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM episode_diagnoses WHERE episode_id = ?`);
		const row = stmt.get(episodeId) as RawDiagnosisRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToDiagnosis(row);
	}

	async listRecent(limit: number): Promise<ToolChainDiagnosis[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM episode_diagnoses
			ORDER BY recorded_at DESC
			LIMIT ?
		`);
		const rows = stmt.all(limit) as RawDiagnosisRow[];
		stmt.finalize();
		return rows.map(rowToDiagnosis);
	}

	async listByEpisodeIds(episodeIds: string[]): Promise<ToolChainDiagnosis[]> {
		if (episodeIds.length === 0) return [];
		const placeholders = episodeIds.map(() => "?").join(",");
		const stmt = this.db.prepare(`
			SELECT * FROM episode_diagnoses WHERE episode_id IN (${placeholders})
		`);
		const rows = stmt.all(...episodeIds) as RawDiagnosisRow[];
		stmt.finalize();
		return rows.map(rowToDiagnosis);
	}

	async count(): Promise<number> {
		const stmt = this.db.prepare(`SELECT COUNT(*) as c FROM episode_diagnoses`);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}

	async deleteOld(keepCount: number): Promise<number> {
		const countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM episode_diagnoses`);
		const countRow = countStmt.get() as { c: number };
		countStmt.finalize();

		const toDelete = countRow.c - keepCount;
		if (toDelete <= 0) return 0;

		const stmt = this.db.prepare(`
			DELETE FROM episode_diagnoses
			WHERE episode_id IN (
				SELECT episode_id FROM episode_diagnoses ORDER BY recorded_at ASC LIMIT ?
			)
		`);
		stmt.run(toDelete);
		stmt.finalize();
		return toDelete;
	}
}

function rowToDiagnosis(row: RawDiagnosisRow): ToolChainDiagnosis {
	return {
		sessionId: row.episode_id,
		readFailures: safeJsonParse(row.read_failures_json, []),
		cascadePatterns: safeJsonParse(row.cascade_patterns_json, []),
		redundantSearches: Boolean(row.redundant_searches),
		slowLoop: Boolean(row.slow_loop),
		toolEfficiency: row.tool_efficiency,
		dominantErrorTool: row.dominant_error_tool ?? undefined,
		dominantErrorPattern: row.dominant_error_pattern ?? undefined,
		suggestedAction: row.suggested_action,
	};
}

function safeJsonParse<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}
