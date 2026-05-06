/**
 * SQLite implementation of ProfileStore.
 */
import type { Database } from "bun:sqlite";
import type { UserProfile } from "../types";
import type { ProfileStore } from "./types";

export class SqliteProfileStore implements ProfileStore {
	constructor(private db: Database) {}

	async get(id: string): Promise<UserProfile | undefined> {
		const stmt = this.db.prepare(`SELECT profile_json FROM user_profiles WHERE id = ?`);
		const row = stmt.get(id) as { profile_json: string } | undefined;
		stmt.finalize();
		if (!row) return undefined;
		try {
			return JSON.parse(row.profile_json) as UserProfile;
		} catch {
			return undefined;
		}
	}

	async upsert(id: string, profile: UserProfile): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO user_profiles (id, profile_json, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				profile_json = excluded.profile_json,
				updated_at = excluded.updated_at
		`);
		stmt.run(id, JSON.stringify(profile), profile.updatedAt);
		stmt.finalize();
	}
}
