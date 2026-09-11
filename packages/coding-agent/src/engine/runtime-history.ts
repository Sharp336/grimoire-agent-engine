import { type BlobRange, type BlobStore, parseBlobRef } from "../session/blob-store";
import { copyOriginalAttachments, type SessionEntry, type SessionOriginalAttachment } from "../session/session-entries";
import { EngineTargetError } from "./contracts";
import type { HistoryLifecycleContext } from "./runtime-lifecycle";
import type { RuntimeQueryWork, RuntimeSql } from "./runtime-projection";
import { runtimeLimits } from "./runtime-protocol";
import { RuntimeTextReader } from "./runtime-text";

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

// Incremental SQLite TEXT reads require a rowid table. Keep the same canonical
// data, primary key, secondary indexes and session-file triggers; no shadow store.
export const ENGINE_HISTORY_ROWID_SCHEMA = [
	"CREATE TABLE engine_history_entries_rowid(session_path TEXT NOT NULL,entry_id TEXT NOT NULL,parent_entry_id TEXT,ordinal INTEGER NOT NULL,entry_type TEXT NOT NULL,entry_role TEXT,entry_json TEXT NOT NULL,entry_bytes INTEGER NOT NULL,tool_call_id TEXT,source_command_id TEXT,assistant_message_id TEXT,PRIMARY KEY(session_path,entry_id))",
	"INSERT INTO engine_history_entries_rowid SELECT session_path,entry_id,parent_entry_id,ordinal,entry_type,entry_role,entry_json,entry_bytes,tool_call_id,source_command_id,assistant_message_id FROM engine_history_entries",
	...(["insert", "append", "replace", "remove", "move"] as const).map(name => `DROP TRIGGER engine_history_${name}`),
	"DROP TABLE engine_history_entries",
	"ALTER TABLE engine_history_entries_rowid RENAME TO engine_history_entries",
	...ENGINE_HISTORY_INDEX_SCHEMA.filter(
		statement => statement.startsWith("CREATE INDEX") || statement.startsWith("CREATE TRIGGER"),
	),
	"CREATE INDEX engine_history_header_idx ON engine_history_entries(session_path,entry_type,ordinal)",
	"CREATE INDEX engine_attempts_history_path_idx ON engine_attempts(agent_instance_id,transcript_session_id,transcript_path)",
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
		"SELECT entry_bytes FROM engine_history_entries WHERE session_path=? AND entry_id=?",
		[sessionPath, entryId],
	)) as Array<{ entry_bytes: number }>;
	work?.rows(rows.length);
	if (!rows[0]) throw new EngineTargetError("history_expired", "Native history entry expired");
	const total = Number(rows[0].entry_bytes);
	if (offset > total) throw new EngineTargetError("invalid_request", "History range starts after the retained entry");
	const reader = await RuntimeTextReader.open(sql, agentInstanceId, work);
	let bytes: Buffer;
	try {
		bytes = reader.history(sessionPath, session.entry_id, entryId, revision, total, offset, limit, attemptId);
	} finally {
		reader.close();
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

/** Read an inline or externalized image only through its exact retained native-history owner. */
export async function readNativeHistoryImage(
	sql: RuntimeSql,
	agentInstanceId: string,
	resource: Record<string, unknown>,
	offset: number,
	limit: number,
	blobs: BlobStore,
	work: RuntimeQueryWork,
): Promise<{ resource: Record<string, unknown>; offset: number; nextOffset: number | null; contentBase64: string }> {
	// Reuse the native Attempt/session/lineage guard; do not authorize a bare hash.
	const entry = await readNativeHistoryEntry(
		sql,
		agentInstanceId,
		String(resource.entryId),
		String(resource.revision),
		0,
		1,
		String(resource.sessionId),
		String(resource.attemptId),
		work,
	);
	if (entry.totalBytes > runtimeLimits.httpPageBytes)
		throw new EngineTargetError(
			"restore_budget",
			"Image metadata entry exceeds the bounded history page; full entry recovery is required",
		);
	const block = `$.message.content[${resource.blockIndex}]`;
	const rows = await sql.unsafe(
		`SELECT json_extract(h.entry_json,?) AS type,
		json_extract(h.entry_json,?) AS data,
		substr(json_extract(h.entry_json,?),1,201) AS media_type
		FROM engine_attempts a JOIN omp_session_files f ON f.path=a.transcript_path
		JOIN engine_history_entries h ON h.session_path=f.path
		WHERE a.agent_instance_id=? AND a.attempt_id=? AND a.transcript_session_id=?
		AND f.history_lineage=? AND h.entry_id=? AND h.entry_bytes=?`,
		[
			`${block}.type`,
			`${block}.data`,
			`${block}.mimeType`,
			agentInstanceId,
			String(resource.attemptId),
			String(resource.sessionId),
			String(resource.revision),
			String(resource.entryId),
			entry.totalBytes,
		],
	);
	work.rows(rows.length);
	work.value.materializedBytes += entry.totalBytes;
	work.check();
	const image = rows[0];
	const hash = typeof image?.data === "string" ? parseBlobRef(image.data) : null;
	const inline = hash ? null : nativeInlineImage(image?.data);
	if (
		image?.type !== "image" ||
		(!hash && !inline) ||
		resource.contentHash !== `sha256:${hash ?? new Bun.SHA256().update(inline!).digest("hex")}` ||
		image.media_type !== resource.mediaType
	)
		throw new EngineTargetError("stale_target", "Image descriptor differs from the retained content block");
	let range: BlobRange | null;
	try {
		if (inline) {
			const end = Math.min(inline.length, offset + limit);
			work.value.materializedBytes += inline.length;
			range = {
				data: inline.subarray(offset, end),
				totalBytes: inline.length,
				nextOffset: end < inline.length ? end : null,
			};
		} else range = await blobs.getRange(hash!, offset, limit);
	} catch {
		throw new EngineTargetError("source_unavailable", "Retained image bytes cannot be read safely");
	}
	if (!range) throw new EngineTargetError("history_expired", "Retained image bytes are unavailable");
	if (range.totalBytes !== resource.bytes) throw new EngineTargetError("stale_target", "Image resource size changed");
	work.value.materializedBytes += range.data.length;
	work.check();
	return { resource, offset, nextOffset: range.nextOffset, contentBase64: range.data.toString("base64") };
}

/** Read original uploads by message ownership, never by caller-supplied blob identity alone. */
export async function readNativeHistoryAttachment(
	sql: RuntimeSql,
	agentInstanceId: string,
	resource: Record<string, unknown>,
	offset: number,
	limit: number,
	blobs: BlobStore,
	work: RuntimeQueryWork,
): Promise<{ resource: Record<string, unknown>; offset: number; nextOffset: number | null; contentBase64: string }> {
	const entry = await readNativeHistoryEntry(
		sql,
		agentInstanceId,
		String(resource.entryId),
		String(resource.revision),
		0,
		1,
		String(resource.sessionId),
		String(resource.attemptId),
		work,
	);
	if (entry.totalBytes > runtimeLimits.httpPageBytes)
		throw new EngineTargetError("restore_budget", "Attachment metadata entry requires bounded full entry recovery");
	const rows = await sql.unsafe(
		`SELECT json_extract(h.entry_json,?) AS descriptor
		FROM engine_attempts a JOIN omp_session_files f ON f.path=a.transcript_path
		JOIN engine_history_entries h ON h.session_path=f.path
		WHERE a.agent_instance_id=? AND a.attempt_id=? AND a.transcript_session_id=?
		AND f.history_lineage=? AND h.entry_id=? AND h.entry_bytes=?
		AND h.entry_type='message' AND h.entry_role='user'`,
		[
			`$.originalAttachments[${resource.attachmentIndex}]`,
			agentInstanceId,
			String(resource.attemptId),
			String(resource.sessionId),
			String(resource.revision),
			String(resource.entryId),
			entry.totalBytes,
		],
	);
	work.rows(rows.length);
	work.value.materializedBytes += entry.totalBytes;
	work.check();
	let attachment: SessionOriginalAttachment;
	try {
		attachment = copyOriginalAttachments([JSON.parse(String(rows[0]?.descriptor))])[0]!;
	} catch {
		throw new EngineTargetError("stale_target", "Attachment descriptor is not retained on this user message");
	}
	if (
		attachment.name !== resource.name ||
		attachment.mediaType !== resource.mediaType ||
		attachment.contentHash !== resource.contentHash ||
		attachment.bytes !== resource.bytes
	)
		throw new EngineTargetError("stale_target", "Attachment descriptor differs from the retained original");
	let range: BlobRange | null;
	try {
		range = await blobs.getRange(attachment.contentHash.slice(7), offset, limit);
	} catch {
		throw new EngineTargetError("source_unavailable", "Original attachment cannot be read safely");
	}
	if (!range) throw new EngineTargetError("history_expired", "Original attachment bytes are unavailable");
	if (range.totalBytes !== attachment.bytes)
		throw new EngineTargetError("stale_target", "Original attachment size changed");
	work.value.materializedBytes += range.data.length;
	work.check();
	return { resource, offset, nextOffset: range.nextOffset, contentBase64: range.data.toString("base64") };
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

export interface HistoryImageResource {
	kind: "history_image";
	agentInstanceRef: string;
	attemptId: string;
	sessionId: string;
	entryId: string;
	revision: string;
	blockIndex: number;
	mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	bytes: number;
	contentHash: string;
}

export interface HistoryAttachmentResource extends SessionOriginalAttachment {
	kind: "history_attachment";
	agentInstanceRef: string;
	attemptId: string;
	sessionId: string;
	entryId: string;
	revision: string;
	attachmentIndex: number;
}

export interface EngineHistoryAttachment {
	entryId: string;
	attachmentIndex: number;
	name?: string;
	status: "available" | "unavailable";
	resource?: HistoryAttachmentResource;
	reason?: "invalid_metadata" | "history_expired" | "source_unavailable" | "restore_budget";
}

export async function nativeHistoryAttachments(
	page: EngineNativeHistoryPage,
	agentInstanceRef: string,
	blobs: BlobStore,
): Promise<Map<string, EngineHistoryAttachment[]>> {
	const started = performance.now();
	const result = new Map<string, EngineHistoryAttachment[]>();
	const attemptId = page.lifecycleContext.targetAttemptId ?? page.lifecycleContext.currentAttemptId;
	for (const entry of page.entries as SessionEntry[]) {
		if (entry.type !== "message" || entry.message.role !== "user" || entry.originalAttachments === undefined)
			continue;
		let originals: SessionOriginalAttachment[];
		try {
			originals = copyOriginalAttachments(entry.originalAttachments);
		} catch {
			result.set(entry.id, [
				{ entryId: entry.id, attachmentIndex: 0, status: "unavailable", reason: "invalid_metadata" },
			]);
			continue;
		}
		const attachments: EngineHistoryAttachment[] = [];
		for (const [attachmentIndex, original] of originals.entries()) {
			const attachment: EngineHistoryAttachment = {
				entryId: entry.id,
				attachmentIndex,
				name: original.name,
				status: "unavailable",
			};
			attachments.push(attachment);
			if (!attemptId) attachment.reason = "history_expired";
			else if (page.elapsedMs + performance.now() - started >= runtimeLimits.replayTimeoutMs)
				attachment.reason = "restore_budget";
			else {
				try {
					const range = await blobs.getRange(original.contentHash.slice(7), 0, 1);
					if (!range) attachment.reason = "history_expired";
					else if (range.totalBytes !== original.bytes) attachment.reason = "source_unavailable";
					else {
						page.readBytes += range.data.length;
						attachment.status = "available";
						attachment.resource = {
							...original,
							kind: "history_attachment",
							agentInstanceRef,
							attemptId,
							sessionId: page.sessionId,
							entryId: entry.id,
							revision: page.lifecycleContext.lineage,
							attachmentIndex,
						};
					}
				} catch {
					attachment.reason = "source_unavailable";
				}
			}
		}
		if (attachments.length) result.set(entry.id, attachments);
	}
	page.elapsedMs += Math.ceil(performance.now() - started);
	return result;
}

export interface EngineHistoryImage {
	entryId: string;
	blockIndex: number;
	status: "available" | "unavailable";
	resource?: HistoryImageResource;
	reason?: "unsupported_format" | "invalid_image" | "history_expired" | "source_unavailable" | "restore_budget";
}

export type EngineHistoryMediaBlock =
	| { blockIndex: number; text: string }
	| { blockIndex: number; image: EngineHistoryImage };

export function historyMediaBlocks(content: unknown, images: EngineHistoryImage[]): EngineHistoryMediaBlock[] {
	if (!Array.isArray(content)) return [];
	const byIndex = new Map(images.map(image => [image.blockIndex, image]));
	return content.flatMap<EngineHistoryMediaBlock>((block, blockIndex) => {
		const image = byIndex.get(blockIndex);
		if (image) return [{ blockIndex, image }];
		return block?.type === "text" && typeof block.text === "string" ? [{ blockIndex, text: block.text }] : [];
	});
}

function nativeInlineImage(value: unknown): Buffer | null {
	if (typeof value !== "string" || value.length > runtimeLimits.httpPageBytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
		return null;
	const bytes = Buffer.from(value, "base64");
	return bytes.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "") ? bytes : null;
}

/** Project references, never binary payloads. Reads stay within the history query budget. */
export async function nativeHistoryImages(
	page: EngineNativeHistoryPage,
	agentInstanceRef: string,
	blobs: BlobStore,
): Promise<Map<string, EngineHistoryImage[]>> {
	const started = performance.now();
	const images = new Map<string, EngineHistoryImage[]>();
	const attemptId = page.lifecycleContext.targetAttemptId ?? page.lifecycleContext.currentAttemptId;
	for (const entry of page.entries as SessionEntry[]) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant" && entry.message.role !== "toolResult")
			continue;
		if (!Array.isArray(entry.message.content)) continue;
		for (const [blockIndex, block] of entry.message.content.entries()) {
			if (!block || typeof block !== "object" || block.type !== "image") continue;
			const image: EngineHistoryImage = { entryId: entry.id, blockIndex, status: "unavailable" };
			const entryImages = images.get(entry.id) ?? [];
			entryImages.push(image);
			images.set(entry.id, entryImages);
			const mime = block.mimeType;
			const hash = typeof block.data === "string" ? parseBlobRef(block.data) : null;
			const inline = hash ? null : nativeInlineImage(block.data);
			if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/gif" && mime !== "image/webp") {
				image.reason = "unsupported_format";
			} else if (blockIndex > 65_535 || (!hash && !inline)) {
				image.reason = "invalid_image";
			} else if (!attemptId) {
				image.reason = "history_expired";
			} else if (page.elapsedMs + performance.now() - started >= runtimeLimits.replayTimeoutMs) {
				image.reason = "restore_budget";
			} else {
				try {
					// One byte establishes the actual size through the same safe file reader as resource access.
					const range = inline ? { data: inline, totalBytes: inline.length } : await blobs.getRange(hash!, 0, 1);
					if (!range) image.reason = "history_expired";
					else {
						page.readBytes += range.data.length;
						image.status = "available";
						image.resource = {
							kind: "history_image",
							agentInstanceRef,
							attemptId,
							sessionId: page.sessionId,
							entryId: entry.id,
							revision: page.lifecycleContext.lineage,
							blockIndex,
							mediaType: mime,
							bytes: range.totalBytes,
							contentHash: `sha256:${hash ?? new Bun.SHA256().update(inline!).digest("hex")}`,
						};
					}
				} catch {
					image.reason = "source_unavailable";
				}
			}
		}
	}
	page.elapsedMs += Math.ceil(performance.now() - started);
	return images;
}
