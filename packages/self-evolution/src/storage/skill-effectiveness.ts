/**
 * SQLite implementation of SkillEffectivenessStore.
 */
import type { Database } from "bun:sqlite";
import type { SkillEffectiveness } from "../types";
import type { SkillEffectivenessStore } from "./types";

export class SqliteSkillEffectivenessStore implements SkillEffectivenessStore {
	constructor(private db: Database) {}

	async get(skillName: string): Promise<SkillEffectiveness | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM skill_effectiveness WHERE skill_name = ?`);
		const row = stmt.get(skillName) as RawRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToEffectiveness(row);
	}

	async recordInjection(skillName: string): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO skill_effectiveness (skill_name, times_injected, times_helped, times_failed, last_injected_at)
			VALUES (?, 1, 0, 0, ?)
			ON CONFLICT(skill_name) DO UPDATE SET
				times_injected = times_injected + 1,
				last_injected_at = excluded.last_injected_at
		`);
		stmt.run(skillName, Date.now());
		stmt.finalize();
	}

	async recordOutcome(skillName: string, succeeded: boolean): Promise<void> {
		const column = succeeded ? "times_helped" : "times_failed";
		const stmt = this.db.prepare(`
			INSERT INTO skill_effectiveness (skill_name, times_injected, times_helped, times_failed, last_injected_at)
			VALUES (?, 0, 0, 0, 0)
			ON CONFLICT(skill_name) DO UPDATE SET
				${column} = ${column} + 1
		`);
		stmt.run(skillName);
		stmt.finalize();
	}
}

interface RawRow {
	skill_name: string;
	times_injected: number;
	times_helped: number;
	times_failed: number;
	last_injected_at: number;
}

function rowToEffectiveness(row: RawRow): SkillEffectiveness {
	return {
		skillName: row.skill_name,
		timesInjected: row.times_injected,
		timesHelped: row.times_helped,
		timesFailed: row.times_failed,
		lastInjectedAt: row.last_injected_at,
	};
}
