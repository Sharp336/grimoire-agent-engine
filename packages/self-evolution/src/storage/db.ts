/**
 * SQLite database initialization for self-evolution.
 */

import { Database } from "bun:sqlite";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

let dbInstance: Database | undefined;

export function getEvolutionDb(cwd: string): Database {
	if (dbInstance) return dbInstance;

	const dbDir = path.join(cwd, ".omp", "self-evolution");
	const dbPath = path.join(dbDir, "evolution.db");

	// Bun.write auto-creates parent dirs when writing files, but SQLite
	// open() needs the directory to exist. Use sync mkdir for init.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs");
	fs.mkdirSync(dbDir, { recursive: true });

	dbInstance = new Database(dbPath);
	dbInstance.exec("PRAGMA journal_mode = WAL;");
	dbInstance.exec("PRAGMA foreign_keys = ON;");

	initSchema(dbInstance);
	logger.debug("Self-evolution DB initialized", { path: dbPath });
	return dbInstance;
}

export function closeEvolutionDb(): void {
	if (dbInstance) {
		dbInstance.close();
		dbInstance = undefined;
	}
}

export function initSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS episodes (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL,
			tool_call_count INTEGER NOT NULL,
			error_count INTEGER NOT NULL,
			had_recovery INTEGER NOT NULL,
			completed_successfully INTEGER NOT NULL,
			summary TEXT NOT NULL,
			tools_used TEXT NOT NULL,
			files_modified TEXT NOT NULL
		);
	`);

	// FTS5 virtual table for full-text search over episodes
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
			user_prompt, summary, tools_used,
			content='episodes',
			content_rowid='rowid'
		);
	`);

	// Triggers to keep FTS5 in sync
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS episodes_fts_insert AFTER INSERT ON episodes BEGIN
			INSERT INTO episodes_fts(rowid, user_prompt, summary, tools_used)
			VALUES (new.rowid, new.user_prompt, new.summary, new.tools_used);
		END;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS episodes_fts_delete AFTER DELETE ON episodes BEGIN
			INSERT INTO episodes_fts(episodes_fts, rowid, user_prompt, summary, tools_used)
			VALUES ('delete', old.rowid, old.user_prompt, old.summary, old.tools_used);
		END;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS episodes_fts_update AFTER UPDATE ON episodes BEGIN
			INSERT INTO episodes_fts(episodes_fts, rowid, user_prompt, summary, tools_used)
			VALUES ('delete', old.rowid, old.user_prompt, old.summary, old.tools_used);
			INSERT INTO episodes_fts(rowid, user_prompt, summary, tools_used)
			VALUES (new.rowid, new.user_prompt, new.summary, new.tools_used);
		END;
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS skills (
			name TEXT PRIMARY KEY,
			description TEXT NOT NULL,
			task_pattern TEXT NOT NULL,
			approach TEXT NOT NULL,
			tools TEXT NOT NULL,
			pitfalls TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			usage_count INTEGER NOT NULL,
			last_used_at INTEGER NOT NULL,
			success_count INTEGER NOT NULL,
			failure_count INTEGER NOT NULL,
			version INTEGER NOT NULL,
			quality_score INTEGER,
			optimized_prompt TEXT,
			deprecated INTEGER NOT NULL DEFAULT 0,
			deprecation_reason TEXT
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_versions (
			name TEXT NOT NULL,
			version INTEGER NOT NULL,
			skill_json TEXT NOT NULL,
			changed_at INTEGER NOT NULL,
			change_type TEXT NOT NULL,
			change_reason TEXT,
			PRIMARY KEY (name, version)
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS stats (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		);
	`);
}
