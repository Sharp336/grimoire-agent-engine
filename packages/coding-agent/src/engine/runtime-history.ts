import { EngineTargetError } from "./contracts";
import type { HistoryLifecycleContext } from "./runtime-lifecycle";
import type { RuntimeQueryWork, RuntimeSql } from "./runtime-projection";
import { runtimeLimits } from "./runtime-protocol";

function jsonLines(content: string): string {
	const array = `'[' || replace(trim(${content},char(10)||char(13)||' '),char(10),',') || ']'`;
	return `CASE WHEN json_valid(${array}) THEN ${array} ELSE '[]' END`;
}

function indexEntries(sessionPath: string, content: string, offset: string): string {
	return `INSERT INTO engine_history_entries(session_path,entry_id,parent_entry_id,ordinal,entry_type,entry_role,entry_json,entry_bytes,tool_call_id)
	 SELECT ${sessionPath},json_extract(j.value,'$.id'),json_extract(j.value,'$.parentId'),CAST(j.key AS INTEGER)+${offset},json_extract(j.value,'$.type'),json_extract(j.value,'$.message.role'),j.value,length(CAST(j.value AS BLOB)),json_extract(j.value,'$.message.toolCallId')
	 FROM json_each(${jsonLines(content)}) j WHERE json_type(j.value,'$.id')='text'
	 ON CONFLICT(session_path,entry_id) DO UPDATE SET parent_entry_id=excluded.parent_entry_id,ordinal=excluded.ordinal,entry_type=excluded.entry_type,entry_role=excluded.entry_role,entry_json=excluded.entry_json,entry_bytes=excluded.entry_bytes,tool_call_id=excluded.tool_call_id;`;
}

export const ENGINE_HISTORY_INDEX_SCHEMA = [
	`CREATE TABLE engine_history_entries(session_path TEXT NOT NULL,entry_id TEXT NOT NULL,parent_entry_id TEXT,ordinal INTEGER NOT NULL,entry_type TEXT NOT NULL,entry_role TEXT,entry_json TEXT NOT NULL,entry_bytes INTEGER NOT NULL,tool_call_id TEXT,PRIMARY KEY(session_path,entry_id)) WITHOUT ROWID`,
	`CREATE INDEX engine_history_page_idx ON engine_history_entries(session_path,ordinal)`,
	`CREATE INDEX engine_history_tool_idx ON engine_history_entries(session_path,tool_call_id) WHERE tool_call_id IS NOT NULL`,
	`CREATE TRIGGER engine_history_insert AFTER INSERT ON omp_session_files WHEN NEW.path LIKE '%.jsonl' BEGIN ${indexEntries("NEW.path", "NEW.content", "0")} END`,
	`CREATE TRIGGER engine_history_append AFTER UPDATE OF content ON omp_session_files WHEN NEW.path LIKE '%.jsonl' AND length(NEW.content)>=length(OLD.content) AND substr(NEW.content,1,length(OLD.content))=OLD.content BEGIN ${indexEntries("NEW.path", "substr(NEW.content,length(OLD.content)+1)", "(SELECT COALESCE(MAX(ordinal),-1)+1 FROM engine_history_entries WHERE session_path=NEW.path)")} END`,
	`CREATE TRIGGER engine_history_replace AFTER UPDATE OF content ON omp_session_files WHEN NEW.path LIKE '%.jsonl' AND (length(NEW.content)<length(OLD.content) OR substr(NEW.content,1,length(OLD.content))<>OLD.content) BEGIN DELETE FROM engine_history_entries WHERE session_path=OLD.path; ${indexEntries("NEW.path", "NEW.content", "0")} END`,
	`CREATE TRIGGER engine_history_remove AFTER DELETE ON omp_session_files BEGIN DELETE FROM engine_history_entries WHERE session_path=OLD.path; END`,
	`CREATE TRIGGER engine_history_move AFTER UPDATE OF path ON omp_session_files BEGIN UPDATE engine_history_entries SET session_path=NEW.path WHERE session_path=OLD.path; END`,
	`INSERT INTO engine_history_entries(session_path,entry_id,parent_entry_id,ordinal,entry_type,entry_role,entry_json,entry_bytes,tool_call_id)
	 SELECT f.path,json_extract(j.value,'$.id'),json_extract(j.value,'$.parentId'),CAST(j.key AS INTEGER),json_extract(j.value,'$.type'),json_extract(j.value,'$.message.role'),j.value,length(CAST(j.value AS BLOB)),json_extract(j.value,'$.message.toolCallId')
	 FROM omp_session_files f,json_each(${jsonLines("f.content")}) j WHERE f.path LIKE '%.jsonl' AND json_type(j.value,'$.id')='text'`,
] as const;

export const ENGINE_HISTORY_LINEAGE_SCHEMA = [
	"ALTER TABLE omp_session_files ADD COLUMN history_lineage TEXT NOT NULL DEFAULT 'legacy'",
	"CREATE TRIGGER engine_history_lineage_insert AFTER INSERT ON omp_session_files BEGIN UPDATE omp_session_files SET history_lineage=lower(hex(randomblob(16))) WHERE path=NEW.path; END",
	"CREATE TRIGGER engine_history_lineage_replace AFTER UPDATE OF content ON omp_session_files WHEN length(NEW.content)<length(OLD.content) OR substr(NEW.content,1,length(OLD.content))<>OLD.content BEGIN UPDATE omp_session_files SET history_lineage=lower(hex(randomblob(16))) WHERE path=NEW.path; END",
	"CREATE INDEX engine_attempts_history_owner_idx ON engine_attempts(agent_instance_id,transcript_session_id)",
] as const;

export async function readNativeHistoryEntry(
	sql: RuntimeSql,
	agentInstanceId: string,
	entryId: string,
	revision: string,
	offset: number,
	limit: number,
	expectedSessionId?: string,
	attemptId?: string,
	work?: RuntimeQueryWork,
): Promise<{
	sessionId: string;
	entryId: string;
	revision: string;
	offset: number;
	totalBytes: number;
	contentBase64: string;
	nextOffset: number | null;
}> {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > runtimeLimits.deliveryBatchBytes
	)
		throw new EngineTargetError("invalid_request", "History range is outside the owner byte budget");
	const attempts = attemptId
		? ((await sql.unsafe(
				"SELECT transcript_path AS path FROM engine_attempts WHERE agent_instance_id=? AND attempt_id=? AND transcript_session_id=?",
				[agentInstanceId, attemptId, expectedSessionId ?? ""],
			)) as Array<{ path: string | null }>)
		: expectedSessionId
			? ((await sql.unsafe(
					"SELECT transcript_path AS path FROM engine_attempts WHERE agent_instance_id=? AND transcript_session_id=? LIMIT 1",
					[agentInstanceId, expectedSessionId],
				)) as Array<{ path: string | null }>)
			: [];
	work?.rows(attempts.length);
	if (attemptId && !attempts[0]?.path)
		throw new EngineTargetError("stale_target", "History resource does not belong to this exact Attempt");
	const bindings = attempts[0]?.path
		? []
		: ((await sql.unsafe("SELECT session_file AS path FROM engine_runtime_bindings WHERE agent_instance_id=?", [
				agentInstanceId,
			])) as Array<{ path: string | null }>);
	work?.rows(bindings.length);
	const sessionPath = attempts[0]?.path ?? bindings[0]?.path;
	if (!sessionPath) throw new EngineTargetError("history_expired", "Native history is not retained");
	const sessions = (await sql.unsafe(
		"SELECT h.entry_id,f.history_lineage FROM engine_history_entries h JOIN omp_session_files f ON f.path=h.session_path WHERE h.session_path=? AND h.entry_type='session' ORDER BY h.ordinal LIMIT 1",
		[sessionPath],
	)) as Array<{ entry_id: string; history_lineage: string }>;
	work?.rows(sessions.length);
	const session = sessions[0];
	if (
		!session ||
		(expectedSessionId && session.entry_id !== expectedSessionId) ||
		session.history_lineage !== revision
	)
		throw new EngineTargetError("stale_target", "History resource session or immutable lineage changed");
	const rows = (await sql.unsafe(
		"SELECT entry_bytes,SUBSTR(CAST(entry_json AS BLOB),?,?) AS chunk FROM engine_history_entries WHERE session_path=? AND entry_id=?",
		[offset + 1, limit, sessionPath, entryId],
	)) as Array<{ entry_bytes: number; chunk: Uint8Array }>;
	work?.rows(rows.length);
	if (!rows[0]) throw new EngineTargetError("history_expired", "Native history entry expired");
	const bytes = Buffer.from(rows[0].chunk);
	const total = Number(rows[0].entry_bytes);
	if (offset > total) throw new EngineTargetError("invalid_request", "History range starts after the retained entry");
	if (work) {
		work.value.materializedBytes += bytes.length;
		work.check();
	}
	return {
		sessionId: session.entry_id,
		entryId,
		revision,
		offset,
		totalBytes: total,
		contentBase64: bytes.toString("base64"),
		nextOffset: offset + bytes.length < total ? offset + bytes.length : null,
	};
}

export interface EngineNativeHistoryPage {
	sessionId: string;
	revision: string;
	anchor: string | null;
	entries: unknown[];
	nextCursor: string | null;
	lifecycleContext: HistoryLifecycleContext;
	entryRef?: { entryId: string; revision: string; bytes: number; method: "runtime.history.entry" };
	/** Exact continuation when the public projection of the first entry needs a resource. */
	projectionFallback?: {
		entryRef: NonNullable<EngineNativeHistoryPage["entryRef"]>;
		nextCursor: string | null;
	};
	activityRefs?: Array<{
		toolCallId: string;
		entryId: string;
		revision: string;
		bytes: number;
		method: "runtime.history.entry";
	}>;
	visitedRecords: number;
	readBytes: number;
	elapsedMs: number;
}
