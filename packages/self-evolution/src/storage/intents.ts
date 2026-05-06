/**
 * SQLite implementation of IntentStore.
 */
import type { Database } from "bun:sqlite";
import type { EpisodeIntent } from "../types";
import type { IntentStore } from "./types";

export class SqliteIntentStore implements IntentStore {
	constructor(private db: Database) {}

	async insert(intent: EpisodeIntent): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO episode_intents (episode_id, intent, confidence, source)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(episode_id, intent) DO UPDATE SET
				confidence = excluded.confidence,
				source = excluded.source
		`);
		stmt.run(intent.episodeId, intent.intent, intent.confidence, intent.source);
		stmt.finalize();
	}

	async getByEpisode(episodeId: string): Promise<EpisodeIntent[]> {
		const stmt = this.db.prepare(`SELECT * FROM episode_intents WHERE episode_id = ?`);
		const rows = stmt.all(episodeId) as RawIntentRow[];
		stmt.finalize();
		return rows.map(rowToIntent);
	}

	async getByIntent(intent: string, limit: number): Promise<EpisodeIntent[]> {
		const stmt = this.db.prepare(`SELECT * FROM episode_intents WHERE intent = ? ORDER BY confidence DESC LIMIT ?`);
		const rows = stmt.all(intent, limit) as RawIntentRow[];
		stmt.finalize();
		return rows.map(rowToIntent);
	}
}

interface RawIntentRow {
	episode_id: string;
	intent: string;
	confidence: number;
	source: string;
}

function rowToIntent(row: RawIntentRow): EpisodeIntent {
	return {
		episodeId: row.episode_id,
		intent: row.intent as EpisodeIntent["intent"],
		confidence: row.confidence,
		source: row.source as EpisodeIntent["source"],
	};
}
