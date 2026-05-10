/**
 * Migrate per-project self-evolution data to the global store.
 *
 * Usage: bun run packages/self-evolution/scripts/migrate-to-global.ts
 *
 * Scans all evolution.db files under the current working directory tree,
 * merges their data into ~/.omp/self-evolution/evolution.db, and removes
 * the per-project directories after successful merge.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initSchema } from "../src/storage/db";
import type { UserProfile } from "../src/types";

const GLOBAL_DB_DIR = path.join(os.homedir(), ".omp", "self-evolution");
const GLOBAL_DB_PATH = path.join(GLOBAL_DB_DIR, "evolution.db");

function findProjectDbs(cwd: string): string[] {
	const results: string[] = [];
	function walk(dir: string) {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) {
						// Skip hidden dirs but allow .omp
						if (entry.name !== ".omp") continue;
					}
					const full = path.join(dir, entry.name);
					if (entry.name === "evolution.db" && dir.endsWith("self-evolution")) {
						results.push(path.join(dir, entry.name));
					} else {
						walk(full);
					}
				}
			}
		} catch {
			// Permission denied or not a directory
		}
	}
	walk(cwd);
	return results.filter(p => p !== GLOBAL_DB_PATH);
}

function ensureGlobalDb(): Database {
	fs.mkdirSync(GLOBAL_DB_DIR, { recursive: true });
	const db = new Database(GLOBAL_DB_PATH);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	initSchema(db);
	return db;
}

function attachAndMerge(globalDb: Database, sourcePath: string): void {
	const attachName = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	globalDb.exec(`ATTACH DATABASE '${sourcePath}' AS ${attachName}`);

	// Episodes — INSERT OR IGNORE (id is unique across projects)
	globalDb.exec(`
		INSERT OR IGNORE INTO episodes
		SELECT * FROM ${attachName}.episodes
	`);

	// Episode intents
	globalDb.exec(`
		INSERT OR IGNORE INTO episode_intents
		SELECT * FROM ${attachName}.episode_intents
	`);

	// Skills — merge by name, keep higher qualityScore
	const skillRows = globalDb
		.prepare(`
		SELECT s.* FROM ${attachName}.skills s
	`)
		.all() as Array<Record<string, unknown>>;
	for (const row of skillRows) {
		const name = row.name as string;
		const existing = globalDb.prepare("SELECT quality_score FROM skills WHERE name = ?").get(name) as
			| { quality_score: number }
			| undefined;
		if (!existing) {
			globalDb
				.prepare(`
				INSERT INTO skills (name, description, task_pattern, approach, tools, pitfalls, created_at, usage_count, last_used_at, success_count, failure_count, version, quality_score, optimized_prompt, deprecated, deprecation_reason)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
				.run(
					row.name,
					row.description,
					row.task_pattern,
					row.approach,
					row.tools,
					row.pitfalls,
					row.created_at,
					row.usage_count,
					row.last_used_at,
					row.success_count,
					row.failure_count,
					row.version,
					row.quality_score,
					row.optimized_prompt,
					row.deprecated,
					row.deprecation_reason,
				);
		} else if (((row.quality_score as number | null) ?? 0) > (existing.quality_score ?? 0)) {
			globalDb
				.prepare(`
				UPDATE skills SET
					description = ?, task_pattern = ?, approach = ?, tools = ?, pitfalls = ?,
					created_at = ?, usage_count = ?, last_used_at = ?, success_count = ?, failure_count = ?,
					version = ?, quality_score = ?, optimized_prompt = ?, deprecated = ?, deprecation_reason = ?
				WHERE name = ?
			`)
				.run(
					row.description,
					row.task_pattern,
					row.approach,
					row.tools,
					row.pitfalls,
					row.created_at,
					row.usage_count,
					row.last_used_at,
					row.success_count,
					row.failure_count,
					row.version,
					row.quality_score,
					row.optimized_prompt,
					row.deprecated,
					row.deprecation_reason,
					row.name,
				);
		}
	}

	// Skill versions
	globalDb.exec(`
		INSERT OR IGNORE INTO skill_versions
		SELECT * FROM ${attachName}.skill_versions
	`);

	// Conventions — id is content hash, INSERT OR IGNORE handles dedup
	globalDb.exec(`
		INSERT OR IGNORE INTO conventions
		SELECT * FROM ${attachName}.conventions
	`);

	// Stats — sum by key
	const statRows = globalDb.prepare(`SELECT key, value FROM ${attachName}.stats`).all() as Array<{
		key: string;
		value: number;
	}>;
	for (const { key, value } of statRows) {
		const existing = globalDb.prepare("SELECT value FROM stats WHERE key = ?").get(key) as
			| { value: number }
			| undefined;
		if (!existing) {
			globalDb.prepare("INSERT INTO stats (key, value) VALUES (?, ?)").run(key, value);
		} else {
			globalDb.prepare("UPDATE stats SET value = value + ? WHERE key = ?").run(value, key);
		}
	}

	// Workflow patterns — merge by intent + tool_sequence, sum occurrence_count
	const wfRows = globalDb.prepare(`SELECT * FROM ${attachName}.workflow_patterns`).all() as Array<
		Record<string, unknown>
	>;
	for (const row of wfRows) {
		const existing = globalDb
			.prepare("SELECT id, occurrence_count FROM workflow_patterns WHERE intent = ? AND tool_sequence = ?")
			.get(row.intent, row.tool_sequence) as { id: string; occurrence_count: number } | undefined;
		if (!existing) {
			globalDb
				.prepare(`
				INSERT INTO workflow_patterns (id, intent, tool_sequence, occurrence_count, avg_quality_score, last_seen_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
				.run(row.id, row.intent, row.tool_sequence, row.occurrence_count, row.avg_quality_score, row.last_seen_at);
		} else {
			globalDb
				.prepare(`
				UPDATE workflow_patterns SET
					occurrence_count = occurrence_count + ?,
					last_seen_at = MAX(last_seen_at, ?)
				WHERE id = ?
			`)
				.run(row.occurrence_count, row.last_seen_at, existing.id);
		}
	}

	// Episode effectiveness — merge: sum injected/helped/failed
	const effRows = globalDb.prepare(`SELECT * FROM ${attachName}.episode_effectiveness`).all() as Array<
		Record<string, unknown>
	>;
	for (const row of effRows) {
		const existing = globalDb
			.prepare("SELECT times_injected, times_helped, times_failed FROM episode_effectiveness WHERE episode_id = ?")
			.get(row.episode_id) as { times_injected: number; times_helped: number; times_failed: number } | undefined;
		if (!existing) {
			globalDb
				.prepare(
					"INSERT INTO episode_effectiveness (episode_id, times_injected, times_helped, times_failed) VALUES (?, ?, ?, ?)",
				)
				.run(row.episode_id, row.times_injected, row.times_helped, row.times_failed);
		} else {
			globalDb
				.prepare(`
				UPDATE episode_effectiveness SET
					times_injected = times_injected + ?,
					times_helped = times_helped + ?,
					times_failed = times_failed + ?
				WHERE episode_id = ?
			`)
				.run(row.times_injected, row.times_helped, row.times_failed, row.episode_id);
		}
	}

	// Skill effectiveness — merge: sum + last_injected_at = MAX
	const seRows = globalDb.prepare(`SELECT * FROM ${attachName}.skill_effectiveness`).all() as Array<
		Record<string, unknown>
	>;
	for (const row of seRows) {
		const existing = globalDb
			.prepare(
				"SELECT times_injected, times_helped, times_failed, last_injected_at FROM skill_effectiveness WHERE skill_name = ?",
			)
			.get(row.skill_name) as
			| { times_injected: number; times_helped: number; times_failed: number; last_injected_at: number }
			| undefined;
		if (!existing) {
			globalDb
				.prepare(
					"INSERT INTO skill_effectiveness (skill_name, times_injected, times_helped, times_failed, last_injected_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(row.skill_name, row.times_injected, row.times_helped, row.times_failed, row.last_injected_at);
		} else {
			globalDb
				.prepare(`
				UPDATE skill_effectiveness SET
					times_injected = times_injected + ?,
					times_helped = times_helped + ?,
					times_failed = times_failed + ?,
					last_injected_at = MAX(last_injected_at, ?)
				WHERE skill_name = ?
			`)
				.run(row.times_injected, row.times_helped, row.times_failed, row.last_injected_at, row.skill_name);
		}
	}

	// Nudge history
	globalDb.exec(`
		INSERT OR IGNORE INTO nudge_history
		SELECT * FROM ${attachName}.nudge_history
	`);

	// Convention feedback
	globalDb.exec(`
		INSERT OR IGNORE INTO convention_feedback
		SELECT * FROM ${attachName}.convention_feedback
	`);

	// Detailed outcomes
	globalDb.exec(`
		INSERT OR IGNORE INTO episode_detailed_outcomes
		SELECT * FROM ${attachName}.episode_detailed_outcomes
	`);

	globalDb.exec(`DETACH DATABASE ${attachName}`);
}

function mergeProfiles(globalDb: Database, sourcePaths: string[]): void {
	const profiles: UserProfile[] = [];
	for (const p of sourcePaths) {
		try {
			const db = new Database(p);
			const row = db.prepare("SELECT profile_json FROM user_profiles WHERE id = 'default'").get() as
				| { profile_json: string }
				| undefined;
			db.close();
			if (row) {
				profiles.push(JSON.parse(row.profile_json) as UserProfile);
			}
		} catch {
			// ignore
		}
	}

	if (profiles.length === 0) return;

	const merged: UserProfile = {
		toolFrequency: {},
		toolTransitions: {},
		intentDistribution: {},
		avgToolCallsPerSession: 0,
		avgFilesModifiedPerSession: 0,
		errorRate: 0,
		recoveryRate: 0,
		preferredLanguages: [],
		sessionCount: 0,
		updatedAt: Date.now(),
	};

	let totalSessions = 0;
	let totalErrors = 0;
	let totalRecoveries = 0;
	let totalToolCalls = 0;
	let totalFilesModified = 0;

	for (const p of profiles) {
		totalSessions += p.sessionCount;
		totalErrors += p.errorRate * p.sessionCount;
		totalRecoveries += p.recoveryRate * p.sessionCount;
		totalToolCalls += p.avgToolCallsPerSession * p.sessionCount;
		totalFilesModified += p.avgFilesModifiedPerSession * p.sessionCount;

		for (const [tool, count] of Object.entries(p.toolFrequency)) {
			merged.toolFrequency[tool] = (merged.toolFrequency[tool] ?? 0) + count;
		}
		for (const [trans, count] of Object.entries(p.toolTransitions)) {
			merged.toolTransitions[trans] = (merged.toolTransitions[trans] ?? 0) + count;
		}
		for (const [intent, count] of Object.entries(p.intentDistribution)) {
			merged.intentDistribution[intent] = (merged.intentDistribution[intent] ?? 0) + count;
		}
		for (const lang of p.preferredLanguages) {
			if (!merged.preferredLanguages.includes(lang)) {
				merged.preferredLanguages.push(lang);
			}
		}
	}

	merged.sessionCount = totalSessions;
	merged.errorRate = totalSessions > 0 ? totalErrors / totalSessions : 0;
	merged.recoveryRate = totalSessions > 0 ? totalRecoveries / totalSessions : 0;
	merged.avgToolCallsPerSession = totalSessions > 0 ? totalToolCalls / totalSessions : 0;
	merged.avgFilesModifiedPerSession = totalSessions > 0 ? totalFilesModified / totalSessions : 0;

	globalDb
		.prepare(`
		INSERT INTO user_profiles (id, profile_json, updated_at)
		VALUES ('default', ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			profile_json = excluded.profile_json,
			updated_at = excluded.updated_at
	`)
		.run(JSON.stringify(merged), Date.now());
}

function removeProjectDirs(sourcePaths: string[]): void {
	for (const p of sourcePaths) {
		const dir = path.dirname(p);
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			console.log(`Removed: ${dir}`);
		} catch (err) {
			console.error(`Failed to remove ${dir}:`, err);
		}
	}
}

async function main(): Promise<void> {
	const cwd = process.cwd();
	const sourcePaths = findProjectDbs(cwd);

	if (sourcePaths.length === 0) {
		console.log("No per-project evolution.db files found. Nothing to migrate.");
		return;
	}

	console.log(`Found ${sourcePaths.length} per-project DB(s):`);
	for (const p of sourcePaths) console.log(`  - ${p}`);

	const globalDb = ensureGlobalDb();

	for (const sourcePath of sourcePaths) {
		console.log(`Merging: ${sourcePath}...`);
		attachAndMerge(globalDb, sourcePath);
	}

	console.log("Merging user profiles...");
	mergeProfiles(globalDb, sourcePaths);

	// Rebuild FTS5 index
	console.log("Rebuilding FTS5 index...");
	globalDb.exec(`INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')`);

	globalDb.close();

	console.log("Removing per-project directories...");
	removeProjectDirs(sourcePaths);

	console.log("Migration complete. Global store: ~/.omp/self-evolution/evolution.db");
	console.log("\nIMPORTANT: Restart omp for changes to take effect.");
	console.log("The self-evolution-global-store flag is now default true.");
}

main().catch(console.error);
