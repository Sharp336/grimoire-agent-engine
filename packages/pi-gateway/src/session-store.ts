/**
 * SQLite-based session store.
 *
 * Persists sessions and messages to SQLite for durability across restarts.
 * Each session is keyed by (channelId, conversationId) for 1:1 mapping
 * between an IM conversation and an agent session.
 */

import { Database, type Statement } from "bun:sqlite";
import type { SessionRecord, SessionStore } from "./types";

// ═══════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_id TEXT,
  omp_session_path TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(channel_id, conversation_id)
);`;
// ═══════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════

export class SQLiteSessionStore implements SessionStore {
	#db: Database;
	#getSessionByConv: Statement<SessionRecord, [string, string]>;
	#insertSession: Statement<
		void,
		[string, string, string, string, number, number, string | null, string | null, string]
	>;
	#updateSession: Statement<void, [number, string | null, string | null, string, string]>;
	#closeSession: Statement<void, [number, string]>;
	#getActiveSessions: Statement<SessionRecord, [string | null]>;

	constructor(dbPath: string) {
		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec(SCHEMA);

		this.#getSessionByConv = this.#db.prepare<SessionRecord, [string, string]>(`
			SELECT id, channel_id as channelId, user_id as userId, conversation_id as conversationId,
			       created_at as createdAt, updated_at as updatedAt,
			       last_message_id as lastMessageId, omp_session_path as ompSessionPath, status
			FROM sessions
			WHERE channel_id = ? AND conversation_id = ? AND status != 'closed'
		`);

		this.#insertSession = this.#db.prepare(`
			INSERT INTO sessions (id, channel_id, user_id, conversation_id, created_at, updated_at, last_message_id, omp_session_path, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.#updateSession = this.#db.prepare(`
			UPDATE sessions SET updated_at = ?, last_message_id = COALESCE(?, last_message_id),
			                    omp_session_path = COALESCE(?, omp_session_path),
			                    status = COALESCE(NULLIF(?, ''), status)
			WHERE id = ?
		`);

		this.#closeSession = this.#db.prepare(`
			UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?
		`);

		this.#getActiveSessions = this.#db.prepare<SessionRecord, [string | null]>(`
			SELECT id, channel_id as channelId, user_id as userId, conversation_id as conversationId,
			       created_at as createdAt, updated_at as updatedAt,
			       last_message_id as lastMessageId, omp_session_path as ompSessionPath, status
			FROM sessions
			WHERE status != 'closed' AND channel_id = COALESCE(?, channel_id)
		`);
	}

	async getSession(channelId: string, conversationId: string): Promise<SessionRecord | null> {
		return this.#getSessionByConv.get(channelId, conversationId) ?? null;
	}

	async createSession(session: Omit<SessionRecord, "id">): Promise<SessionRecord> {
		const id = crypto.randomUUID();
		this.#insertSession.run(
			id,
			session.channelId,
			session.userId,
			session.conversationId,
			session.createdAt,
			session.updatedAt,
			session.lastMessageId ?? null,
			session.ompSessionPath ?? null,
			session.status ?? "active",
		);
		return { ...session, id };
	}

	async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
		const now = Date.now();
		this.#updateSession.run(
			now,
			updates.lastMessageId ?? null,
			updates.ompSessionPath ?? null,
			updates.status ?? "",
			id,
		);
	}

	async closeSession(id: string): Promise<void> {
		this.#closeSession.run(Date.now(), id);
	}

	async getActiveSessions(channelId?: string): Promise<SessionRecord[]> {
		return this.#getActiveSessions.all(channelId ?? null);
	}

	close(): void {
		this.#db.close();
	}
}
