/**
 * Skill and skill-version storage.
 */
import type { Database } from "bun:sqlite";
import type { EvolvedSkill, SkillVersion } from "../types";
import type { SkillStore, SkillVersionStore, StatsStore } from "./types";

export class SqliteSkillStore implements SkillStore {
	constructor(private db: Database) {}

	async get(name: string): Promise<EvolvedSkill | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM skills WHERE name = ?`);
		const row = stmt.get(name) as RawSkillRow | undefined;
		stmt.finalize();
		return row ? rowToSkill(row) : undefined;
	}

	async list(filter?: { deprecated?: boolean }): Promise<EvolvedSkill[]> {
		let sql = `SELECT * FROM skills`;
		const params: (string | number)[] = [];
		if (filter?.deprecated !== undefined) {
			sql += ` WHERE deprecated = ?`;
			params.push(filter.deprecated ? 1 : 0);
		}
		sql += ` ORDER BY last_used_at DESC`;

		const stmt = this.db.prepare(sql);
		const rows = stmt.all(...params) as RawSkillRow[];
		stmt.finalize();
		return rows.map(rowToSkill);
	}

	async upsert(skill: EvolvedSkill): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO skills (
				name, description, task_pattern, approach, tools, pitfalls,
				created_at, usage_count, last_used_at, success_count, failure_count,
				version, quality_score, optimized_prompt, deprecated, deprecation_reason
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(name) DO UPDATE SET
				description = excluded.description,
				task_pattern = excluded.task_pattern,
				approach = excluded.approach,
				tools = excluded.tools,
				pitfalls = excluded.pitfalls,
				usage_count = excluded.usage_count,
				last_used_at = excluded.last_used_at,
				success_count = excluded.success_count,
				failure_count = excluded.failure_count,
				version = excluded.version,
				quality_score = excluded.quality_score,
				optimized_prompt = excluded.optimized_prompt,
				deprecated = excluded.deprecated,
				deprecation_reason = excluded.deprecation_reason
		`);
		stmt.run(
			skill.name,
			skill.description,
			skill.taskPattern,
			skill.approach,
			JSON.stringify(skill.tools),
			JSON.stringify(skill.pitfalls),
			skill.createdAt,
			skill.usageCount,
			skill.lastUsedAt,
			skill.successCount,
			skill.failureCount,
			skill.version,
			skill.qualityScore ?? null,
			skill.optimizedPrompt ?? null,
			skill.deprecated ? 1 : 0,
			skill.deprecationReason ?? null,
		);
		stmt.finalize();
	}

	async delete(name: string): Promise<void> {
		const stmt = this.db.prepare(`DELETE FROM skills WHERE name = ?`);
		stmt.run(name);
		stmt.finalize();
	}

	async count(): Promise<number> {
		const stmt = this.db.prepare(`SELECT COUNT(*) as c FROM skills`);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}
}

export class SqliteSkillVersionStore implements SkillVersionStore {
	constructor(private db: Database) {}

	async record(version: SkillVersion): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO skill_versions (name, version, skill_json, changed_at, change_type, change_reason)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(name, version) DO UPDATE SET
				skill_json = excluded.skill_json,
				changed_at = excluded.changed_at,
				change_type = excluded.change_type,
				change_reason = excluded.change_reason
		`);
		stmt.run(
			version.name,
			version.version,
			JSON.stringify(version.skill),
			version.changedAt,
			version.changeType,
			version.changeReason ?? null,
		);
		stmt.finalize();
	}

	async getHistory(name: string): Promise<SkillVersion[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM skill_versions WHERE name = ? ORDER BY version DESC
		`);
		const rows = stmt.all(name) as RawVersionRow[];
		stmt.finalize();
		return rows.map(rowToVersion);
	}

	async getSpecific(name: string, version: number): Promise<SkillVersion | undefined> {
		const stmt = this.db.prepare(`
			SELECT * FROM skill_versions WHERE name = ? AND version = ?
		`);
		const row = stmt.get(name, version) as RawVersionRow | undefined;
		stmt.finalize();
		return row ? rowToVersion(row) : undefined;
	}

	async prune(name: string, keepCount: number): Promise<number> {
		const countStmt = this.db.prepare(`
			SELECT COUNT(*) as c FROM skill_versions WHERE name = ?
		`);
		const countRow = countStmt.get(name) as { c: number };
		countStmt.finalize();

		const toDelete = countRow.c - keepCount;
		if (toDelete <= 0) return 0;

		const stmt = this.db.prepare(`
			DELETE FROM skill_versions
			WHERE name = ? AND version IN (
				SELECT version FROM skill_versions WHERE name = ? ORDER BY version ASC LIMIT ?
			)
		`);
		stmt.run(name, name, toDelete);
		stmt.finalize();
		return toDelete;
	}

	async count(): Promise<number> {
		const stmt = this.db.prepare(`SELECT COUNT(*) as c FROM skill_versions`);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}
}

export class SqliteStatsStore implements StatsStore {
	constructor(private db: Database) {}

	async get(key: string): Promise<number> {
		const stmt = this.db.prepare(`SELECT value FROM stats WHERE key = ?`);
		const row = stmt.get(key) as { value: number } | undefined;
		stmt.finalize();
		return row?.value ?? 0;
	}

	async increment(key: string, delta = 1): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO stats (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
		`);
		stmt.run(key, delta);
		stmt.finalize();
	}
}

interface RawSkillRow {
	name: string;
	description: string;
	task_pattern: string;
	approach: string;
	tools: string;
	pitfalls: string;
	created_at: number;
	usage_count: number;
	last_used_at: number;
	success_count: number;
	failure_count: number;
	version: number;
	quality_score: number | null;
	optimized_prompt: string | null;
	deprecated: number;
	deprecation_reason: string | null;
}

interface RawVersionRow {
	name: string;
	version: number;
	skill_json: string;
	changed_at: number;
	change_type: string;
	change_reason: string | null;
}

function rowToSkill(row: RawSkillRow): EvolvedSkill {
	return {
		name: row.name,
		description: row.description,
		taskPattern: row.task_pattern,
		approach: row.approach,
		tools: safeJsonParse(row.tools, []),
		pitfalls: safeJsonParse(row.pitfalls, []),
		createdAt: row.created_at,
		usageCount: row.usage_count,
		lastUsedAt: row.last_used_at,
		successCount: row.success_count,
		failureCount: row.failure_count,
		version: row.version,
		qualityScore: row.quality_score ?? undefined,
		optimizedPrompt: row.optimized_prompt ?? undefined,
		deprecated: Boolean(row.deprecated),
		deprecationReason: row.deprecation_reason ?? undefined,
	};
}

function rowToVersion(row: RawVersionRow): SkillVersion {
	return {
		name: row.name,
		version: row.version,
		skill: safeJsonParse(row.skill_json, {} as EvolvedSkill),
		changedAt: row.changed_at,
		changeType: row.change_type as SkillVersion["changeType"],
		changeReason: row.change_reason ?? undefined,
	};
}

function safeJsonParse<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}
