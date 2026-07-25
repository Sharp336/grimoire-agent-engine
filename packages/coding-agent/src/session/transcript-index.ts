import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { getTranscriptDbPath, logger } from "@oh-my-pi/pi-utils";
import { escapeLikePattern } from "./history-storage";
import { type FileEntry, type LabelEntry, SESSION_TAG_PREFIX, type SessionHeader } from "./session-entries";
import { loadEntriesFromFile } from "./session-loader";

export interface TranscriptHit {
	sessionId: string;
	filePath: string;
	entryId: string;
	kind: "message_text" | "tool_use" | "tool_result";
	role: string;
	snippet: string;
	createdAt: number;
}

type ChunkKind = TranscriptHit["kind"];

type ChunkRow = {
	id: number;
	file_path: string;
	session_id: string;
	entry_id: string;
	kind: string;
	role: string;
	content: string;
	created_at: number;
};

type IndexedFileRow = {
	path: string;
	mtime_ms: number;
	size: number;
};

type PreparedChunk = {
	filePath: string;
	sessionId: string;
	entryId: string;
	kind: ChunkKind;
	role: string;
	content: string;
	createdAt: number;
};

const TOOL_USE_CONTENT_CAP = 4096;
const TOOL_RESULT_CONTENT_CAP = 16_384;

function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}

function isLlmMessage(message: AgentMessage): message is Message {
	return (
		message.role === "user" ||
		message.role === "developer" ||
		message.role === "assistant" ||
		message.role === "toolResult"
	);
}

function capContent(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

function entryCreatedAtMs(timestamp: string, fileMtimeMs: number): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : fileMtimeMs;
}

function extractChunks(
	entries: FileEntry[],
	filePath: string,
	sessionId: string,
	fileMtimeMs: number,
): PreparedChunk[] {
	const chunks: PreparedChunk[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!isLlmMessage(message)) continue;

		const createdAt = entryCreatedAtMs(entry.timestamp, fileMtimeMs);
		const push = (kind: PreparedChunk["kind"], role: string, content: string): void => {
			if (content.length === 0) return;
			chunks.push({ filePath, sessionId, entryId: entry.id, kind, role, content, createdAt });
		};

		switch (message.role) {
			case "user":
			case "developer": {
				if (typeof message.content === "string") {
					push("message_text", message.role, message.content);
					break;
				}
				for (const block of message.content) {
					switch (block.type) {
						case "text":
							push("message_text", message.role, block.text);
							break;
						case "image":
							break;
						default:
							assertNever(block);
					}
				}
				break;
			}
			case "assistant": {
				for (const block of message.content) {
					switch (block.type) {
						case "text":
							push("message_text", message.role, block.text);
							break;
						case "toolCall": {
							const raw = `${block.name} ${JSON.stringify(block.arguments)}`;
							push("tool_use", "", capContent(raw, TOOL_USE_CONTENT_CAP));
							break;
						}
						case "thinking":
						case "redactedThinking":
						case "fallback":
						case "anthropicServerTool":
						case "image":
							break;
						default:
							assertNever(block);
					}
				}
				break;
			}
			case "toolResult": {
				for (const block of message.content) {
					switch (block.type) {
						case "text":
							push("tool_result", "", capContent(block.text, TOOL_RESULT_CONTENT_CAP));
							break;
						case "image":
							break;
						default:
							assertNever(block);
					}
				}
				break;
			}
			default:
				assertNever(message);
		}
	}

	return chunks;
}

function extractSessionTags(entries: FileEntry[]): string[] {
	// Last label per targetId wins (same fold as SessionEntryIndex), then keep
	// non-empty labels so a clearing `label: ""` removes the tag.
	const latestByTarget = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		const labelEntry = entry as LabelEntry;
		if (!labelEntry.targetId.startsWith(SESSION_TAG_PREFIX)) continue;
		latestByTarget.set(labelEntry.targetId, labelEntry.label ?? "");
	}
	const tags: string[] = [];
	for (const label of latestByTarget.values()) {
		if (label.length > 0) tags.push(label);
	}
	return tags;
}

function listJsonlFiles(sessionDir: string): string[] {
	try {
		return Array.from(new Bun.Glob("*.jsonl").scanSync(sessionDir)).map(name => path.join(sessionDir, name));
	} catch {
		return [];
	}
}

export class TranscriptIndex {
	#db: Database;
	static #instance?: TranscriptIndex;

	#insertChunkStmt: Statement;
	#deleteChunksStmt: Statement;
	#upsertIndexedFileStmt: Statement;
	#getIndexedFileStmt: Statement;
	#deleteTagsStmt: Statement;
	#insertTagStmt: Statement;
	#tagsForStmt: Statement;
	#sessionIdsByTagStmt: Statement;
	#searchStmt: Statement;
	#substringStmts = new Map<number, Statement>();
	#closed = false;

	private constructor(dbPath: string) {
		this.#ensureDir(dbPath);

		this.#db = new Database(dbPath);
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS indexed_files (
  path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
  session_id TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('message_text','tool_use','tool_result')),
  role TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
-- The LIKE fallback orders by (created_at DESC, id DESC) on every search; without this it
-- scans the whole corpus into a temp b-tree just to discard all but the newest page.
CREATE INDEX IF NOT EXISTS idx_chunks_created_at ON chunks(created_at DESC, id DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content='chunks', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL, file_path TEXT NOT NULL, tag TEXT NOT NULL,
  PRIMARY KEY (session_id, tag)
);
		`);

		this.#insertChunkStmt = this.#db.prepare(
			"INSERT INTO chunks (file_path, session_id, entry_id, kind, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.#deleteChunksStmt = this.#db.prepare("DELETE FROM chunks WHERE file_path = ?");
		this.#upsertIndexedFileStmt = this.#db.prepare(`
INSERT INTO indexed_files (path, mtime_ms, size, session_id, cwd)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  mtime_ms = excluded.mtime_ms,
  size = excluded.size,
  session_id = excluded.session_id,
  cwd = excluded.cwd
		`);
		this.#getIndexedFileStmt = this.#db.prepare("SELECT path, mtime_ms, size FROM indexed_files WHERE path = ?");
		this.#deleteTagsStmt = this.#db.prepare("DELETE FROM session_tags WHERE file_path = ?");
		this.#insertTagStmt = this.#db.prepare(
			"INSERT OR REPLACE INTO session_tags (session_id, file_path, tag) VALUES (?, ?, ?)",
		);
		this.#tagsForStmt = this.#db.prepare("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag");
		this.#sessionIdsByTagStmt = this.#db.prepare(
			"SELECT session_id FROM session_tags WHERE tag = ? ORDER BY session_id",
		);
		this.#searchStmt = this.#db.prepare(
			"SELECT c.id, c.file_path, c.session_id, c.entry_id, c.kind, c.role, c.content, c.created_at FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? ORDER BY c.created_at DESC, c.id DESC LIMIT ?",
		);
	}

	static open(dbPath: string = getTranscriptDbPath()): TranscriptIndex {
		if (!TranscriptIndex.#instance) {
			TranscriptIndex.#instance = new TranscriptIndex(dbPath);
		}
		return TranscriptIndex.#instance;
	}

	/** @internal Reset the singleton and close its database — test-only. */
	static resetInstance(): void {
		const instance = TranscriptIndex.#instance;
		TranscriptIndex.#instance = undefined;
		if (instance) instance.close();
	}

	async reindex(opts: {
		sessionDirs: string[];
		signal?: AbortSignal;
	}): Promise<{ files: number; indexedFiles: number }> {
		let files = 0;
		let indexedFiles = 0;

		for (const sessionDir of opts.sessionDirs) {
			opts.signal?.throwIfAborted();
			const jsonlFiles = listJsonlFiles(sessionDir);
			for (const filePath of jsonlFiles) {
				opts.signal?.throwIfAborted();
				files += 1;

				let stat: fs.Stats;
				try {
					stat = fs.statSync(filePath);
				} catch (error) {
					logger.warn("TranscriptIndex reindex skipped file", { path: filePath, error: String(error) });
					continue;
				}

				const mtimeMs = Math.trunc(stat.mtimeMs);
				const size = stat.size;
				const existing = this.#getIndexedFileStmt.get(filePath) as IndexedFileRow | null;
				if (existing && existing.mtime_ms === mtimeMs && existing.size === size) {
					continue;
				}

				let entries: FileEntry[];
				try {
					entries = await loadEntriesFromFile(filePath);
				} catch (error) {
					logger.warn("TranscriptIndex reindex skipped file", { path: filePath, error: String(error) });
					continue;
				}

				if (entries.length === 0) {
					logger.warn("TranscriptIndex reindex skipped file", {
						path: filePath,
						error: "empty or unreadable session file",
					});
					continue;
				}

				const header = entries[0];
				if (header?.type !== "session" || typeof header.id !== "string") {
					logger.warn("TranscriptIndex reindex skipped file", {
						path: filePath,
						error: "missing session header",
					});
					continue;
				}

				const sessionHeader = header as SessionHeader;
				const sessionId = sessionHeader.id;
				const cwd = sessionHeader.cwd ?? "";
				const chunks = extractChunks(entries, filePath, sessionId, mtimeMs);
				const tags = extractSessionTags(entries);

				try {
					this.#db.transaction(() => {
						this.#deleteChunksStmt.run(filePath);
						this.#deleteTagsStmt.run(filePath);
						for (const chunk of chunks) {
							this.#insertChunkStmt.run(
								chunk.filePath,
								chunk.sessionId,
								chunk.entryId,
								chunk.kind,
								chunk.role,
								chunk.content,
								chunk.createdAt,
							);
						}
						for (const tag of tags) {
							this.#insertTagStmt.run(sessionId, filePath, tag);
						}
						this.#upsertIndexedFileStmt.run(filePath, mtimeMs, size, sessionId, cwd);
					})();
					indexedFiles += 1;
				} catch (error) {
					logger.warn("TranscriptIndex reindex skipped file", { path: filePath, error: String(error) });
				}
			}
		}

		return { files, indexedFiles };
	}

	search(query: string, opts?: { limit?: number }): TranscriptHit[] {
		const safeLimit = this.#normalizeLimit(opts?.limit ?? 100);
		if (safeLimit === 0) return [];

		const tokens = this.#tokenize(query);
		if (tokens.length === 0) return [];

		const ftsQuery = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" ");
		let ftsRows: ChunkRow[] = [];
		try {
			ftsRows = this.#searchStmt.all(ftsQuery, safeLimit) as ChunkRow[];
		} catch (error) {
			logger.debug("TranscriptIndex FTS query failed, using substring only", { error: String(error) });
		}

		let subRows: ChunkRow[] = [];
		try {
			subRows = this.#searchSubstring(tokens, safeLimit);
		} catch (error) {
			logger.error("TranscriptIndex substring search failed", { error: String(error) });
		}

		if (ftsRows.length === 0) {
			return subRows.map(row => this.#toHit(row));
		}

		const rowsById = new Map<number, ChunkRow>();
		for (const row of ftsRows) {
			rowsById.set(row.id, row);
		}
		for (const row of subRows) {
			if (!rowsById.has(row.id)) rowsById.set(row.id, row);
		}

		return [...rowsById.values()]
			.sort((a, b) => b.created_at - a.created_at || b.id - a.id)
			.slice(0, safeLimit)
			.map(row => this.#toHit(row));
	}

	matchingSessionIds(query: string, limit?: number): string[] {
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const hit of this.search(query, { limit: limit ?? 500 })) {
			if (seen.has(hit.sessionId)) continue;
			seen.add(hit.sessionId);
			ids.push(hit.sessionId);
		}
		return ids;
	}

	tagsFor(sessionId: string): string[] {
		const rows = this.#tagsForStmt.all(sessionId) as Array<{ tag: string }>;
		return rows.map(row => row.tag);
	}

	sessionIdsByTag(tag: string): string[] {
		const rows = this.#sessionIdsByTagStmt.all(tag) as Array<{ session_id: string }>;
		return rows.map(row => row.session_id);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const stmt of this.#substringStmts.values()) stmt.finalize();
		this.#substringStmts.clear();
		this.#insertChunkStmt.finalize();
		this.#deleteChunksStmt.finalize();
		this.#upsertIndexedFileStmt.finalize();
		this.#getIndexedFileStmt.finalize();
		this.#deleteTagsStmt.finalize();
		this.#insertTagStmt.finalize();
		this.#tagsForStmt.finalize();
		this.#sessionIdsByTagStmt.finalize();
		this.#searchStmt.finalize();
		this.#db.close();
		if (TranscriptIndex.#instance === this) {
			TranscriptIndex.#instance = undefined;
		}
	}

	#ensureDir(dbPath: string): void {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	#tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(tok => tok.length > 0);
	}

	#searchSubstring(tokens: string[], limit: number): ChunkRow[] {
		const stmt = this.#getSubstringStmt(tokens.length);
		const params: unknown[] = tokens.map(tok => `%${escapeLikePattern(tok)}%`);
		params.push(limit);
		return stmt.all(...(params as [string, ...unknown[]])) as ChunkRow[];
	}

	#getSubstringStmt(tokenCount: number): Statement {
		let stmt = this.#substringStmts.get(tokenCount);
		if (stmt) return stmt;
		const whereClause = Array(tokenCount).fill("content LIKE ? ESCAPE '\\' COLLATE NOCASE").join(" AND ");
		stmt = this.#db.prepare(
			`SELECT id, file_path, session_id, entry_id, kind, role, content, created_at FROM chunks WHERE ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
		);
		this.#substringStmts.set(tokenCount, stmt);
		return stmt;
	}

	#toHit(row: ChunkRow): TranscriptHit {
		const kind = row.kind;
		if (kind !== "message_text" && kind !== "tool_use" && kind !== "tool_result") {
			throw new Error(`Unexpected chunk kind: ${kind}`);
		}
		return {
			sessionId: row.session_id,
			filePath: row.file_path,
			entryId: row.entry_id,
			kind,
			role: row.role,
			snippet: row.content,
			createdAt: row.created_at,
		};
	}
}
