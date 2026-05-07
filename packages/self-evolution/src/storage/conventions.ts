/**
 * SQLite implementation of ConventionStore.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import type { Convention } from "../types";
import type { ConventionStore } from "./types";

interface RawConventionRow {
	id: string;
	type: string;
	content: string;
	source_episode_id: string;
	confidence: number;
	times_applied: number;
	times_violated: number;
	created_at: number;
	last_seen_at: number;
}

export class SqliteConventionStore implements ConventionStore {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async insert(convention: Convention): Promise<void> {
		const normalized = this.#normalize(convention.content);
		const selectStmt = this.#db.prepare("SELECT id, confidence FROM conventions WHERE lower(trim(content)) = ?");
		const existing = selectStmt.get(normalized) as { id: string; confidence: number } | undefined;
		selectStmt.finalize();

		if (existing) {
			const newConfidence = Math.min(100, existing.confidence + 10);
			const updateStmt = this.#db.prepare("UPDATE conventions SET confidence = ?, last_seen_at = ? WHERE id = ?");
			updateStmt.run(newConfidence, convention.lastSeenAt, existing.id);
			updateStmt.finalize();
			logger.debug("Merged duplicate convention", {
				id: existing.id,
				confidence: newConfidence,
			});
			return;
		}

		const stmt = this.#db.prepare(`
			INSERT INTO conventions (
				id, type, content, source_episode_id, confidence,
				times_applied, times_violated, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			convention.id,
			convention.type,
			convention.content,
			convention.sourceEpisodeId,
			convention.confidence,
			convention.timesApplied,
			convention.timesViolated,
			convention.createdAt,
			convention.lastSeenAt,
		);
		stmt.finalize();
	}

	async get(id: string): Promise<Convention | undefined> {
		const stmt = this.#db.prepare("SELECT * FROM conventions WHERE id = ?");
		const row = stmt.get(id) as RawConventionRow | undefined;
		stmt.finalize();
		return row ? rowToConvention(row) : undefined;
	}

	async listAll(): Promise<Convention[]> {
		const stmt = this.#db.prepare("SELECT * FROM conventions ORDER BY last_seen_at DESC");
		const rows = stmt.all() as RawConventionRow[];
		stmt.finalize();
		return rows.map(rowToConvention);
	}

	async listByType(type: string): Promise<Convention[]> {
		const stmt = this.#db.prepare("SELECT * FROM conventions WHERE type = ? ORDER BY confidence DESC");
		const rows = stmt.all(type) as RawConventionRow[];
		stmt.finalize();
		return rows.map(rowToConvention);
	}

	async updateStats(id: string, applied: boolean, violated: boolean): Promise<void> {
		const stmt = this.#db.prepare(`
			UPDATE conventions SET
				times_applied = times_applied + ?,
				times_violated = times_violated + ?
			WHERE id = ?
		`);
		stmt.run(applied ? 1 : 0, violated ? 1 : 0, id);
		stmt.finalize();
	}

	#normalize(content: string): string {
		return content.toLowerCase().trim();
	}
}

function rowToConvention(row: RawConventionRow): Convention {
	return {
		id: row.id,
		type: row.type as Convention["type"],
		content: row.content,
		sourceEpisodeId: row.source_episode_id,
		confidence: row.confidence,
		timesApplied: row.times_applied,
		timesViolated: row.times_violated,
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
	};
}
