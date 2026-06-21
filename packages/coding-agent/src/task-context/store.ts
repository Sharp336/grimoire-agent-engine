import type { Client } from "@libsql/client";

/**
 * Data-access layer over the `summaries` table.
 *
 * Pure CRUD + FTS search + vector search queries. No business logic — just SQL.
 * Ranking fusion, budget packing, staleness checks, and lexical extraction
 * belong to `retrieve.ts`; this module exposes the primitive query channels
 * that the retrieval pipeline composes.
 */

export interface SummaryRow {
	id: number;
	projectLabel: string;
	filePath: string;
	summaryText: string;
	contentHash: string;
	symbolName: string | null;
	symbolKind: string | null;
	symbolLineRange: string | null;
	source: string;
	updatedAt: string;
}

export interface RankedSummary extends SummaryRow {
	score: number;
}

/** Parameters for {@link upsertSummary}. */
export interface UpsertSummaryParams {
	projectLabel: string;
	filePath: string;
	summaryText: string;
	contentHash: string;
	/** Hard cap: summaryText is truncated to this many characters before insert. */
	maxSummaryChars: number;
	symbolName?: string | null;
	symbolKind?: string | null;
	symbolLineRange?: string | null;
}

/**
 * Map a raw libSQL row (snake_case columns) to the camelCase {@link SummaryRow}.
 *
 * libSQL's `Row` interface carries a `[name: string]: Value` index signature,
 * so column access by name is safe here; `Value` is `null | string | number |
 * bigint | ArrayBuffer`, all of which `String()` / `Number()` coerce cleanly.
 */
function mapRow(row: Record<string, unknown>): SummaryRow {
	return {
		id: Number(row.id),
		projectLabel: String(row.project_label),
		filePath: String(row.file_path),
		summaryText: String(row.summary_text),
		contentHash: String(row.content_hash ?? ""),
		symbolName: row.symbol_name != null ? String(row.symbol_name) : null,
		symbolKind: row.symbol_kind != null ? String(row.symbol_kind) : null,
		symbolLineRange: row.symbol_line_range != null ? String(row.symbol_line_range) : null,
		source: String(row.source ?? "agent"),
		updatedAt: String(row.updated_at ?? ""),
	};
}

/**
 * INSERT OR REPLACE a summary, keyed by (project_label, file_path) via the
 * UNIQUE constraint. `summaryText` is hard-truncated to `maxSummaryChars`
 * before insert — the only schema-enforced per-summary token guard. Embedding
 * columns are deliberately untouched (lazy backfill owns them).
 *
 * Returns the inserted row (read back to capture the autoincrement id and
 * server-set `updated_at`).
 */
export async function upsertSummary(client: Client, params: UpsertSummaryParams): Promise<SummaryRow> {
	const truncated = params.summaryText.slice(0, params.maxSummaryChars);
	await client.execute({
		sql: `INSERT INTO summaries (project_label, file_path, summary_text, content_hash, symbol_name, symbol_kind, symbol_line_range)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (project_label, file_path) DO UPDATE SET
				summary_text = excluded.summary_text,
				content_hash = excluded.content_hash,
				symbol_name = excluded.symbol_name,
				symbol_kind = excluded.symbol_kind,
				symbol_line_range = excluded.symbol_line_range,
				updated_at = datetime('now')`,
		args: [
			params.projectLabel,
			params.filePath,
			truncated,
			params.contentHash,
			params.symbolName ?? null,
			params.symbolKind ?? null,
			params.symbolLineRange ?? null,
		],
	});
	const row = await getSummary(client, params.projectLabel, params.filePath);
	if (!row) throw new Error(`codemap: upsert failed to read back summary for ${params.filePath}`);
	return row;
}

/** SELECT a single summary by its (project_label, file_path) key, or null if absent. */
export async function getSummary(client: Client, projectLabel: string, filePath: string): Promise<SummaryRow | null> {
	const result = await client.execute({
		sql: `SELECT * FROM summaries WHERE project_label = ? AND file_path = ?`,
		args: [projectLabel, filePath],
	});
	const row = result.rows[0];
	return row ? mapRow(row) : null;
}

/** DELETE a summary by key. Returns true iff a row was actually removed. */
export async function deleteSummary(client: Client, projectLabel: string, filePath: string): Promise<boolean> {
	const result = await client.execute({
		sql: `DELETE FROM summaries WHERE project_label = ? AND file_path = ?`,
		args: [projectLabel, filePath],
	});
	return Number(result.rowsAffected) > 0;
}

/**
 * Build an FTS5 MATCH expression from a free-text query.
 *
 * Tokenize on non-alphanumeric, lowercase, then wrap each token as
 * `"token"*` (quoted, prefix-wildcard) joined by ` OR ` — FTS5 token-OR
 * with prefix matching. Task queries describe intent, not exact content,
 * so OR (any keyword matches) is more appropriate than AND (all required).
 * Double quotes inside tokens are escaped by doubling (`""`), the FTS5
 * string-literal escape. Tokens shorter than 3 chars are dropped (they
 * match too broadly to be useful seeds). Returns "" when no usable tokens
 * remain, signalling the caller to short-circuit.
 */
function buildFtsQuery(query: string): string {
	const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const filtered = tokens.filter(t => t.length >= 3);
	if (filtered.length === 0) return "";
	return filtered.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" OR ");
}

/**
 * FTS5 lexical search over `summaries_fts` (external-content table over
 * `summaries`). Ranks by `bm25(summaries_fts)` ascending (lower = more
 * relevant) and normalizes the score to [0, 1) where higher = more relevant,
 * consistent with {@link searchVector}'s score semantics so the retrieval
 * pipeline can fuse channels directly.
 */
export async function searchFts(
	client: Client,
	projectLabel: string,
	query: string,
	limit: number,
): Promise<RankedSummary[]> {
	const ftsQuery = buildFtsQuery(query);
	if (!ftsQuery) return [];
	const result = await client.execute({
		sql: `SELECT s.*, bm25(summaries_fts) as fts_rank
			FROM summaries_fts f
			JOIN summaries s ON s.rowid = f.rowid
			WHERE summaries_fts MATCH ?
			AND s.project_label = ?
			ORDER BY fts_rank
			LIMIT ?`,
		args: [ftsQuery, projectLabel, limit],
	});
	return result.rows.map(row => {
		const mapped = mapRow(row);
		// bm25 returns negative values where more-negative = better.
		// |bm25|/(1+|bm25|) maps that to [0,1) with higher = more relevant.
		const absRank = Math.abs(Number(row.fts_rank ?? 0));
		return { ...mapped, score: absRank / (1 + absRank) };
	});
}

/**
 * Vector (semantic) search via the DiskANN index `idx_summaries_embedding`.
 *
 * `vector_top_k` returns the `id` (= rowid, since `id INTEGER PRIMARY KEY`
 * aliases rowid) and cosine `distance` of the k nearest neighbors to the query
 * vector. Cosine distance ranges [0, 2] (0 = identical, 2 = opposite); we map
 * it to a [0, 1] relevance score where higher = more similar, matching
 * {@link searchFts}. Only rows with a non-null `embedding` are reachable —
 * unembedded rows are invisible here and handled by lazy backfill.
 */
export async function searchVector(
	client: Client,
	projectLabel: string,
	queryVector: number[],
	limit: number,
): Promise<RankedSummary[]> {
	if (queryVector.length === 0) return [];
	const vecStr = `[${queryVector.join(",")}]`;
	const result = await client.execute({
		sql: `SELECT s.*, vector_distance_cos(s.embedding, vector32(?)) as vec_distance
			FROM vector_top_k('idx_summaries_embedding', vector32(?), ?) v
			JOIN summaries s ON s.rowid = v.id
			WHERE s.project_label = ?
			ORDER BY vec_distance`,
		args: [vecStr, vecStr, limit, projectLabel],
	});
	return result.rows.map(row => {
		const mapped = mapRow(row);
		const distance = Number(row.vec_distance ?? 2);
		return { ...mapped, score: Math.max(0, 1 - distance / 2) };
	});
}

/**
 * List summaries in a project that have no embedding yet, ordered by
 * recency. Used by the lazy-embed backfill path after FTS retrieval: batch-embed
 * these rows' `summaryText`, then call {@link updateEmbedding} for each.
 */
export async function getUnembeddedSummaries(
	client: Client,
	projectLabel: string,
	limit: number,
): Promise<SummaryRow[]> {
	const result = await client.execute({
		sql: `SELECT * FROM summaries WHERE project_label = ? AND embedding IS NULL ORDER BY updated_at DESC LIMIT ?`,
		args: [projectLabel, limit],
	});
	return result.rows.map(mapRow);
}

/**
 * Populate one row's `embedding` (F32_BLOB via `vector32`) and record the
 * `embed_model` that produced it. The DiskANN vector index updates
 * incrementally on this DML. Callers embedding many rows should batch the
 * updates to amortize index maintenance.
 */
export async function updateEmbedding(client: Client, id: number, embedding: number[], model: string): Promise<void> {
	const vecStr = `[${embedding.join(",")}]`;
	await client.execute({
		sql: `UPDATE summaries SET embedding = vector32(?), embed_model = ? WHERE id = ?`,
		args: [vecStr, model, id],
	});
}

/** Count of summaries stored for a project. */
export async function summaryCount(client: Client, projectLabel: string): Promise<number> {
	const result = await client.execute({
		sql: `SELECT COUNT(*) as count FROM summaries WHERE project_label = ?`,
		args: [projectLabel],
	});
	return Number(result.rows[0]?.count ?? 0);
}
