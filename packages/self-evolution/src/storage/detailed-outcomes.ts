/**
 * SQLite implementation of DetailedOutcomeStore.
 */
import type { Database } from "bun:sqlite";
import type { InjectionOutcome } from "../types";
import type { DetailedOutcomeStore } from "./types";

interface RawRow {
	episode_id: string;
	helpfulness: number;
	has_explicit_correction: number;
	has_explicit_approval: number;
	was_redundant: number;
	avoided_previous_errors: number;
	tool_efficiency: number;
	recorded_at: number;
}

export class SqliteDetailedOutcomeStore implements DetailedOutcomeStore {
	constructor(private db: Database) {}

	async record(outcome: InjectionOutcome): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO episode_detailed_outcomes (
				episode_id, helpfulness, has_explicit_correction, has_explicit_approval,
				was_redundant, avoided_previous_errors, tool_efficiency, recorded_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(episode_id) DO UPDATE SET
				helpfulness = excluded.helpfulness,
				has_explicit_correction = excluded.has_explicit_correction,
				has_explicit_approval = excluded.has_explicit_approval,
				was_redundant = excluded.was_redundant,
				avoided_previous_errors = excluded.avoided_previous_errors,
				tool_efficiency = excluded.tool_efficiency,
				recorded_at = excluded.recorded_at
		`);
		stmt.run(
			outcome.episodeId,
			outcome.helpfulness,
			outcome.hasExplicitCorrection ? 1 : 0,
			outcome.hasExplicitApproval ? 1 : 0,
			outcome.wasRedundant ? 1 : 0,
			outcome.avoidedPreviousErrors ? 1 : 0,
			outcome.toolEfficiency,
			Date.now(),
		);
		stmt.finalize();
	}

	async get(episodeId: string): Promise<InjectionOutcome | undefined> {
		const stmt = this.db.prepare("SELECT * FROM episode_detailed_outcomes WHERE episode_id = ?");
		const row = stmt.get(episodeId) as RawRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToOutcome(row);
	}

	async listRecent(limit: number): Promise<InjectionOutcome[]> {
		const stmt = this.db.prepare("SELECT * FROM episode_detailed_outcomes ORDER BY recorded_at DESC LIMIT ?");
		const rows = stmt.all(limit) as RawRow[];
		stmt.finalize();
		return rows.map(rowToOutcome);
	}
}

function rowToOutcome(row: RawRow): InjectionOutcome {
	return {
		episodeId: row.episode_id,
		helpfulness: row.helpfulness,
		hasExplicitCorrection: Boolean(row.has_explicit_correction),
		hasExplicitApproval: Boolean(row.has_explicit_approval),
		wasRedundant: Boolean(row.was_redundant),
		avoidedPreviousErrors: Boolean(row.avoided_previous_errors),
		toolEfficiency: row.tool_efficiency,
	};
}
