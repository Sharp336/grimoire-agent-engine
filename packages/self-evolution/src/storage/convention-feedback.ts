/**
 * SQLite implementation of ConventionFeedbackStore.
 */
import type { Database } from "bun:sqlite";
import type { ConventionFeedback, ConventionViolation } from "../types";
import type { ConventionFeedbackStore } from "./types";

interface RawFeedbackRow {
	convention_id: string;
	session_id: string;
	complied: number;
	violation_details: string | null;
	recorded_at: number;
}

export class SqliteConventionFeedbackStore implements ConventionFeedbackStore {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
		this.#ensureTable();
	}

	#ensureTable(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS convention_feedback (
				convention_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				complied INTEGER NOT NULL DEFAULT 1,
				violation_details TEXT,
				recorded_at INTEGER NOT NULL,
				PRIMARY KEY (convention_id, session_id)
			)
		`);
	}

	async record(feedback: ConventionFeedback): Promise<void> {
		const stmt = this.#db.prepare(`
			INSERT INTO convention_feedback (convention_id, session_id, complied, violation_details, recorded_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(convention_id, session_id) DO UPDATE SET
				complied = excluded.complied,
				violation_details = excluded.violation_details,
				recorded_at = excluded.recorded_at
		`);
		stmt.run(
			feedback.conventionId,
			feedback.sessionId,
			feedback.complied ? 1 : 0,
			feedback.violationDetails ?? null,
			feedback.recordedAt,
		);
		stmt.finalize();
	}

	async getByConvention(conventionId: string, limit: number): Promise<ConventionFeedback[]> {
		const stmt = this.#db.prepare(
			`SELECT * FROM convention_feedback WHERE convention_id = ? ORDER BY recorded_at DESC LIMIT ?`,
		);
		const rows = stmt.all(conventionId, limit) as RawFeedbackRow[];
		stmt.finalize();
		return rows.map(rowToFeedback);
	}

	async getViolations(since: number): Promise<ConventionViolation[]> {
		const stmt = this.#db.prepare(`
			SELECT
				c.id, c.type, c.content, c.source_episode_id, c.confidence,
				c.times_applied, c.times_violated, c.created_at, c.last_seen_at,
				COUNT(cf.convention_id) as violation_count,
				MAX(cf.recorded_at) as last_violation_at
			FROM conventions c
			JOIN convention_feedback cf ON c.id = cf.convention_id
			WHERE cf.complied = 0 AND cf.recorded_at > ?
			GROUP BY c.id
			ORDER BY violation_count DESC
		`);
		const rows = stmt.all(since) as Array<{
			id: string;
			type: string;
			content: string;
			source_episode_id: string;
			confidence: number;
			times_applied: number;
			times_violated: number;
			created_at: number;
			last_seen_at: number;
			violation_count: number;
			last_violation_at: number;
		}>;
		stmt.finalize();
		return rows.map(r => ({
			convention: {
				id: r.id,
				type: r.type as ConventionViolation["convention"]["type"],
				content: r.content,
				sourceEpisodeId: r.source_episode_id,
				confidence: r.confidence,
				timesApplied: r.times_applied,
				timesViolated: r.times_violated,
				createdAt: r.created_at,
				lastSeenAt: r.last_seen_at,
			},
			violationCount: r.violation_count,
			lastViolationAt: r.last_violation_at,
		}));
	}
}

function rowToFeedback(row: RawFeedbackRow): ConventionFeedback {
	return {
		conventionId: row.convention_id,
		sessionId: row.session_id,
		complied: Boolean(row.complied),
		violationDetails: row.violation_details ?? undefined,
		recordedAt: row.recorded_at,
	};
}

export async function createConventionFeedbackStore(db: Database): Promise<SqliteConventionFeedbackStore> {
	return new SqliteConventionFeedbackStore(db);
}
