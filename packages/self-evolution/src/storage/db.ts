/**
 * SQLite database initialization for self-evolution.
 *
 * Uses per-path reference counting to safely share DB connections across
 * sessions in the same process. Prevents one session's shutdown from
 * closing a DB still in use by another session.
 */
import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

interface DbEntry {
	db: Database;
	refCount: number;
}

const dbCache = new Map<string, DbEntry>();

function resolveDbPath(cwd: string, globalStore?: boolean): string {
	const dbDir = globalStore
		? path.join(os.homedir(), ".omp", "self-evolution")
		: path.join(cwd, ".omp", "self-evolution");
	return path.join(dbDir, "evolution.db");
}

export function getEvolutionDb(cwd: string, globalStore?: boolean): Database {
	const dbPath = resolveDbPath(cwd, globalStore);

	const existing = dbCache.get(dbPath);
	if (existing) {
		existing.refCount++;
		return existing.db;
	}

	// Bun.write auto-creates parent dirs when writing files, but SQLite
	// open() needs the directory to exist. Use sync mkdir for init.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec("PRAGMA busy_timeout = 5000;");

	initSchema(db);
	logger.debug("Self-evolution DB initialized", { path: dbPath });
	dbCache.set(dbPath, { db, refCount: 1 });
	return db;
}

export function closeEvolutionDb(cwd?: string, globalStore?: boolean): void {
	const dbPath = resolveDbPath(cwd ?? "", globalStore);

	const entry = dbCache.get(dbPath);
	if (!entry) return;

	entry.refCount--;
	if (entry.refCount <= 0) {
		entry.db.close();
		dbCache.delete(dbPath);
		logger.debug("Self-evolution DB closed", { path: dbPath });
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
	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_intents (
			episode_id TEXT NOT NULL,
			intent TEXT NOT NULL,
			confidence REAL NOT NULL,
			source TEXT NOT NULL CHECK(source IN ('rule', 'llm')),
			PRIMARY KEY (episode_id, intent),
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_patterns (
			id TEXT PRIMARY KEY,
			intent TEXT NOT NULL,
			tool_sequence TEXT NOT NULL,
			occurrence_count INTEGER NOT NULL DEFAULT 1,
			avg_quality_score REAL,
			last_seen_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS user_profiles (
			id TEXT PRIMARY KEY DEFAULT 'default',
			profile_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_effectiveness (
			episode_id TEXT PRIMARY KEY,
			times_injected INTEGER NOT NULL DEFAULT 0,
			times_helped INTEGER NOT NULL DEFAULT 0,
			times_failed INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_effectiveness (
			skill_name TEXT PRIMARY KEY,
			times_injected INTEGER NOT NULL DEFAULT 0,
			times_helped INTEGER NOT NULL DEFAULT 0,
			times_failed INTEGER NOT NULL DEFAULT 0,
			last_injected_at INTEGER NOT NULL DEFAULT 0
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS nudge_history (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			severity TEXT NOT NULL,
			message TEXT NOT NULL,
			suggestion TEXT NOT NULL,
			detected_at INTEGER NOT NULL,
			dismissed_at INTEGER,
			acknowledged INTEGER NOT NULL DEFAULT 0
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS conventions (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL CHECK(type IN ('negative_rule','positive_rule','preference','project_fact','procedural_rule')),
			content TEXT NOT NULL,
			source_episode_id TEXT NOT NULL,
			confidence INTEGER NOT NULL DEFAULT 50,
			times_applied INTEGER NOT NULL DEFAULT 0,
			times_violated INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_detailed_outcomes (
			episode_id TEXT PRIMARY KEY,
			helpfulness REAL NOT NULL DEFAULT 0,
			has_explicit_correction INTEGER NOT NULL DEFAULT 0,
			has_explicit_approval INTEGER NOT NULL DEFAULT 0,
			was_redundant INTEGER NOT NULL DEFAULT 0,
			avoided_previous_errors INTEGER NOT NULL DEFAULT 0,
			tool_efficiency REAL NOT NULL DEFAULT 0,
			recorded_at INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	// Migrate skills table: add intent column if missing
	const skillsColumns = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
	const hasIntentCol = skillsColumns.some(c => c.name === "intent");
	if (!hasIntentCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN intent TEXT;`);
	}
	const hasAutonomyNotesCol = skillsColumns.some(c => c.name === "autonomy_notes");
	if (!hasAutonomyNotesCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN autonomy_notes TEXT;`);
	}
	const hasLastOptimizedAtCol = skillsColumns.some(c => c.name === "last_optimized_at");
	if (!hasLastOptimizedAtCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN last_optimized_at INTEGER;`);
	}
	const hasUserRatingCol = skillsColumns.some(c => c.name === "user_rating");
	if (!hasUserRatingCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN user_rating INTEGER;`);
	}

	// Migrate nudge_history table: add dismissed_at and acknowledged if missing
	const nudgeColumns = db.prepare("PRAGMA table_info(nudge_history)").all() as Array<{ name: string }>;
	const hasDismissedAtCol = nudgeColumns.some(c => c.name === "dismissed_at");
	if (!hasDismissedAtCol) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN dismissed_at INTEGER;`);
	}
	const hasAcknowledgedCol = nudgeColumns.some(c => c.name === "acknowledged");
	if (!hasAcknowledgedCol) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0;`);
	}
}
