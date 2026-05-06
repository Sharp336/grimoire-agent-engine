/**
 * SQLite implementation of EffectivenessStore.
 */
import type { Database } from "bun:sqlite";
import type { EpisodeEffectiveness } from "../types";
import type { EffectivenessStore } from "./types";

export class SqliteEffectivenessStore implements EffectivenessStore {
	constructor(private db: Database) {}

	async get(episodeId: string): Promise<EpisodeEffectiveness | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM episode_effectiveness WHERE episode_id = ?`);
		const row = stmt.get(episodeId) as RawRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToEffectiveness(row);
	}

	async recordInjection(episodeId: string): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO episode_effectiveness (episode_id, times_injected, times_helped, times_failed)
			VALUES (?, 1, 0, 0)
			ON CONFLICT(episode_id) DO UPDATE SET
				times_injected = times_injected + 1
		`);
		stmt.run(episodeId);
		stmt.finalize();
	}

	async recordOutcome(episodeId: string, helped: boolean): Promise<void> {
		const column = helped ? "times_helped" : "times_failed";
		const stmt = this.db.prepare(`
			INSERT INTO episode_effectiveness (episode_id, times_injected, times_helped, times_failed)
			VALUES (?, 0, 0, 0)
			ON CONFLICT(episode_id) DO UPDATE SET
				${column} = ${column} + 1
		`);
		stmt.run(episodeId);
		stmt.finalize();
	}
}

interface RawRow {
	episode_id: string;
	times_injected: number;
	times_helped: number;
	times_failed: number;
}

function rowToEffectiveness(row: RawRow): EpisodeEffectiveness {
	return {
		episodeId: row.episode_id,
		timesInjected: row.times_injected,
		timesHelped: row.times_helped,
		timesFailed: row.times_failed,
	};
}
