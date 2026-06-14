/**
 * SQLite FTS5-backed OKF store — the local fallback when no Hindsight server
 * is configured.
 *
 * Uses `bun:sqlite` with an FTS5 virtual table for full-text search over
 * concept content (id, type, title, description, tags, body). Results are
 * ranked by bm25 (lower = more relevant).
 *
 * The DB file lives at `<bundleDir>/okf.db` so it travels with the bundle
 * and can be nuked by deleting one file.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OkfConceptSummary } from "../bundle";
import type { OkfListOptions, OkfSearchOptions, OkfSearchResult, OkfStore } from "./types";

/** SQLite implementation of {@link OkfStore}. */
export class SqliteOkfStore implements OkfStore {
	readonly #db: Database;

	constructor(dbPath: string) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });
		this.#db = new Database(dbPath, { create: true });
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec("PRAGMA synchronous = NORMAL;");
		this.#migrate();
	}

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS okf_meta (
				id          TEXT PRIMARY KEY,
				type        TEXT NOT NULL DEFAULT '',
				title       TEXT NOT NULL DEFAULT '',
				description TEXT NOT NULL DEFAULT '',
				tags        TEXT NOT NULL DEFAULT '',
				mtime       INTEGER NOT NULL DEFAULT 0
			);
		`);
		this.#db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS okf_fts USING fts5(
				id, type, title, description, tags, body,
				tokenize = 'porter unicode61'
			);
		`);
	}

	async upsert(summary: OkfConceptSummary, body: string): Promise<void> {
		const tags = summary.tags.join(", ");
		// Upsert metadata.
		this.#db
			.query(
				`INSERT INTO okf_meta (id, type, title, description, tags, mtime)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   type = excluded.type, title = excluded.title,
				   description = excluded.description, tags = excluded.tags,
				   mtime = excluded.mtime`,
			)
			.run(summary.id, summary.type, summary.title ?? "", summary.description, tags, summary.mtime);

		// Replace FTS row (delete + insert — FTS5 external content tables need this).
		const deleteFts = this.#db.query("DELETE FROM okf_fts WHERE id = ?");
		deleteFts.run(summary.id);
		this.#db
			.query(
				`INSERT INTO okf_fts (id, type, title, description, tags, body)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(summary.id, summary.type, summary.title ?? "", summary.description, tags, body);
	}

	async get(id: string): Promise<OkfConceptSummary | undefined> {
		const row = this.#db
			.query("SELECT id, type, title, description, tags, mtime FROM okf_meta WHERE id = ?")
			.get(id) as SqliteRow | null;
		return row ? rowToSummary(row) : undefined;
	}

	async delete(id: string): Promise<void> {
		this.#db.query("DELETE FROM okf_meta WHERE id = ?").run(id);
		this.#db.query("DELETE FROM okf_fts WHERE id = ?").run(id);
	}

	async list(options: OkfListOptions = {}): Promise<OkfConceptSummary[]> {
		const limit = Math.min(options.limit ?? 1000, 10000);
		let sql = "SELECT id, type, title, description, tags, mtime FROM okf_meta";
		const params: (string | number)[] = [];

		const conditions: string[] = [];
		if (options.type) {
			conditions.push("type = ?");
			params.push(options.type);
		}
		if (options.tag) {
			conditions.push("tags LIKE ?");
			params.push(`%${options.tag}%`);
		}
		if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
		sql += " ORDER BY id ASC LIMIT ?";
		params.push(limit);

		const rows = this.#db.query(sql).all(...params) as SqliteRow[];
		return rows.map(rowToSummary);
	}

	async search(query: string, options: OkfSearchOptions = {}): Promise<OkfSearchResult[]> {
		const limit = Math.min(options.limit ?? 10, 100);
		if (!query.trim()) return [];

		// Build an FTS5 MATCH expression from the query terms.
		const matchExpr = buildMatchExpr(query);
		try {
			const rows = this.#db
				.query(
					`SELECT okf_fts.id, okf_meta.type, okf_meta.title, okf_meta.description, okf_meta.tags,
					        bm25(okf_fts) AS score
					 FROM okf_fts
					 JOIN okf_meta ON okf_meta.id = okf_fts.id
					 WHERE okf_fts MATCH ?
					 ORDER BY score ASC
					 LIMIT ?`,
				)
				.all(matchExpr, limit) as SqliteSearchRow[];

			return rows.map(row => ({
				id: row.id,
				type: row.type ?? "",
				title: row.title || undefined,
				description: row.description ?? "",
				tags: parseTagString(row.tags),
				score: row.score,
			}));
		} catch {
			// FTS5 MATCH can throw on malformed queries — degrade gracefully.
			return [];
		}
	}

	async count(): Promise<number> {
		const row = this.#db.query("SELECT COUNT(*) AS n FROM okf_meta").get() as { n: number };
		return row?.n ?? 0;
	}

	async close(): Promise<void> {
		this.#db.close();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SqliteRow {
	id: string;
	type: string;
	title: string;
	description: string;
	tags: string;
	mtime: number;
}

interface SqliteSearchRow {
	id: string;
	type: string;
	title: string;
	description: string;
	tags: string;
	score: number;
}

function rowToSummary(row: SqliteRow): OkfConceptSummary {
	return {
		id: row.id,
		type: row.type,
		title: row.title || undefined,
		description: row.description,
		tags: parseTagString(row.tags),
		filePath: "", // filePath is not stored in the index; callers use bundle.loadConcept
		mtime: row.mtime,
	};
}

function parseTagString(tags: string): string[] {
	return tags
		.split(",")
		.map(t => t.trim())
		.filter(Boolean);
}

/**
 * Build an FTS5 MATCH expression from a free-text query.
 *
 * Wraps each term in double quotes (to handle special chars) and joins with
 * spaces (implicit AND in FTS5). Example: `lsp config` → `"lsp" "config"`.
 */
function buildMatchExpr(query: string): string {
	return query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(term => `"${term.replace(/"/g, '""')}"`)
		.join(" ");
}
