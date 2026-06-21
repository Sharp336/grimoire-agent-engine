import type { Client } from "@libsql/client";

/**
 * DDL for the codemap summaries store.
 *
 * Layout notes:
 * - `summaries.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` — a singular PK with
 *   an implicit ROWID. The `libsql_vector_idx` DiskANN index only works on
 *   tables that have a ROWID or a single-column PRIMARY KEY, so a composite PK
 *   is intentionally NOT used here. Per-file uniqueness is enforced separately
 *   via the `UNIQUE (project_label, file_path)` constraint.
 * - `embedding F32_BLOB(768)` is nullable so embeddings can be computed lazily;
 *   the 768 dimensionality matches bge-base-en-v1.5.
 * - `embed_model` records which model produced the embedding so callers can
 *   detect staleness when the model changes.
 * - `summaries_fts` is an FTS5 external-content table synced via triggers
 *   (after-insert / after-delete / after-update), mirroring the pattern used
 *   by hindsight history-storage. Triggers do NOT fire on replica apply, so
 *   `postSyncMaintenance()` in db.ts rebuilds both FTS and the vector index
 *   after a remote sync.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS summaries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_label    TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  summary_text     TEXT NOT NULL,
  content_hash     TEXT NOT NULL DEFAULT '',
  embedding        F32_BLOB(768),
  embed_model      TEXT,
  symbol_name      TEXT,
  symbol_kind      TEXT,
  symbol_line_range TEXT,
  source           TEXT NOT NULL DEFAULT 'agent',
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_label, file_path)
);

CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project_label);
CREATE INDEX IF NOT EXISTS idx_summaries_hash ON summaries(project_label, content_hash);

CREATE INDEX IF NOT EXISTS idx_summaries_embedding ON summaries(libsql_vector_idx(embedding));

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  summary_text,
  file_path,
  content='summaries',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, summary_text, file_path)
  VALUES (new.rowid, new.summary_text, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, summary_text, file_path)
  VALUES('delete', old.rowid, old.summary_text, old.file_path);
END;

CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, summary_text, file_path)
  VALUES('delete', old.rowid, old.summary_text, old.file_path);
  INSERT INTO summaries_fts(rowid, summary_text, file_path)
  VALUES(new.rowid, new.summary_text, new.file_path);
END;
`;

/**
 * Bootstrap the codemap summaries schema on the given libSQL client.
 *
 * Runs all DDL via `executeMultiple` (which accepts semicolon-separated
 * statements) and then records schema version 1 via `execute` (single
 * statement). `INSERT OR IGNORE` makes this idempotent across re-runs.
 */
export async function initSchema(client: Client): Promise<void> {
	// Execute all DDL statements
	await client.executeMultiple(SCHEMA_SQL);
	// Record schema version
	await client.execute({
		sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
		args: [1],
	});
}
