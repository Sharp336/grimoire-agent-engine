import { type EngineEvent, EngineTargetError } from "./contracts";
import { type RuntimeQueryWork, type RuntimeSql, runtimeIdentity } from "./runtime-projection";
import { type RuntimeAccess, runtimeLimits, validateRuntimeValue } from "./runtime-protocol";

export const RUNTIME_MESSAGE_SCHEMA = [
	`CREATE TABLE engine_runtime_messages(attempt_id TEXT NOT NULL,message_id TEXT NOT NULL,block_id TEXT NOT NULL,stream TEXT NOT NULL,
	 agent_instance_id TEXT NOT NULL,content_id TEXT NOT NULL,revision INTEGER NOT NULL,total_bytes INTEGER NOT NULL,tail_text TEXT NOT NULL,status TEXT NOT NULL,
	 created_event_id INTEGER NOT NULL,last_event_id INTEGER NOT NULL,PRIMARY KEY(attempt_id,message_id,block_id,stream))`,
	"CREATE INDEX engine_runtime_messages_page_idx ON engine_runtime_messages(attempt_id,created_event_id)",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_content_id TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_id TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_block_id TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_stream TEXT",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_revision INTEGER",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_offset INTEGER",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_end_offset INTEGER",
	"ALTER TABLE engine_event_outbox ADD COLUMN message_snapshot TEXT",
	"CREATE INDEX engine_runtime_message_range_idx ON engine_event_outbox(message_content_id,message_offset,event_id) WHERE message_content_id IS NOT NULL",
	"CREATE INDEX engine_runtime_message_data_idx ON engine_event_outbox(message_content_id,message_offset,event_id) WHERE message_end_offset>message_offset",
	"CREATE INDEX engine_runtime_message_revision_idx ON engine_event_outbox(message_content_id,message_revision) WHERE message_content_id IS NOT NULL",
	"CREATE INDEX engine_runtime_message_baseline_idx ON engine_event_outbox(attempt_id,message_id,message_block_id,message_stream,event_id) WHERE message_snapshot IS NOT NULL",
] as const;

interface MessageRow {
	attempt_id: string;
	message_id: string;
	block_id: string;
	stream: string;
	content_id: string;
	revision: number;
	total_bytes: number;
	tail_text: string;
	status: string;
	created_event_id: number;
	last_event_id: number;
}

export function utf8Tail(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	let start = Math.max(0, bytes.length - maxBytes);
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

export function* utf8Chunks(text: string, maxBytes = runtimeLimits.bulkPreviewBytes): Generator<string> {
	// Encode bounded windows, not a second buffer and an array for the complete provider burst.
	for (let start = 0; start < text.length; ) {
		let end = Math.min(text.length, start + maxBytes);
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
		if (end <= start)
			throw new EngineTargetError("invalid_request", "Text chunk budget cannot contain one UTF-8 codepoint");
		const bytes = Buffer.from(text.slice(start, end).toWellFormed());
		for (let offset = 0; offset < bytes.length; ) {
			let take = Math.min(bytes.length, offset + maxBytes);
			while (take < bytes.length && (bytes[take] & 0xc0) === 0x80) take--;
			if (take === offset)
				throw new EngineTargetError("invalid_request", "Text chunk budget cannot contain one UTF-8 codepoint");
			yield bytes.subarray(offset, take).toString("utf8");
			offset = take;
		}
		start = end;
	}
}

export async function recordRuntimeMessage(
	sql: RuntimeSql,
	event: EngineEvent,
	agentInstanceRef: string,
): Promise<Record<string, unknown>> {
	const value = event.payload ?? {};
	validateRuntimeValue("textUpdate", value);
	const rows = (await sql.unsafe(
		"SELECT * FROM engine_runtime_messages WHERE attempt_id=? AND message_id=? AND block_id=? AND stream=?",
		[event.attemptId, String(value.messageId), String(value.blockId), String(value.stream)],
	)) as MessageRow[];
	const previous = rows[0];
	if (value.mode === "append") {
		if (
			!previous ||
			previous.content_id !== value.contentId ||
			Number(previous.revision) !== value.baseRevision ||
			Number(previous.total_bytes) !== value.offset
		)
			throw new EngineTargetError("stale_target", "Message append lost its exact revision or UTF-8 offset");
	} else if (
		value.offset !== 0 ||
		value.partial !== false ||
		value.endOffset !== value.totalBytes ||
		previous?.content_id === value.contentId
	) {
		throw new EngineTargetError(
			"invalid_request",
			"A new retained message lineage requires a complete initial prefix",
		);
	}
	const totalBytes = Number(value.totalBytes);
	const tail = utf8Tail(
		(value.mode === "append" ? previous.tail_text : "") + String(value.text),
		runtimeLimits.bulkPreviewBytes,
	);
	const tailBytes = Buffer.byteLength(tail);
	const snapshot = {
		mode: "snapshot",
		messageId: value.messageId,
		blockId: value.blockId,
		stream: value.stream,
		contentId: value.contentId,
		revision: value.revision,
		offset: totalBytes - tailBytes,
		endOffset: totalBytes,
		totalBytes,
		text: tail,
		status: value.status,
		partial: tailBytes !== totalBytes,
		...(tailBytes !== totalBytes
			? {
					resource: {
						kind: "message",
						agentInstanceRef,
						attemptId: event.attemptId,
						messageId: value.messageId,
						blockId: value.blockId,
						stream: value.stream,
						contentId: value.contentId,
						revision: value.revision,
						mediaType: "text/plain; charset=utf-8",
						bytes: totalBytes,
					},
				}
			: {}),
	};
	validateRuntimeValue("textSnapshot", snapshot);
	await sql.unsafe(
		`INSERT INTO engine_runtime_messages(attempt_id,message_id,block_id,stream,agent_instance_id,content_id,revision,total_bytes,tail_text,status,created_event_id,last_event_id)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id,message_id,block_id,stream) DO UPDATE SET content_id=excluded.content_id,
		revision=excluded.revision,total_bytes=excluded.total_bytes,tail_text=excluded.tail_text,status=excluded.status,last_event_id=excluded.last_event_id`,
		[
			event.attemptId,
			String(value.messageId),
			String(value.blockId),
			String(value.stream),
			event.agentInstanceId,
			String(value.contentId),
			Number(value.revision),
			totalBytes,
			tail,
			String(value.status),
			event.eventId,
			event.eventId,
		],
	);
	await sql.unsafe(
		`UPDATE engine_event_outbox SET message_content_id=?,message_id=?,message_block_id=?,message_stream=?,message_revision=?,message_offset=?,message_end_offset=?,message_snapshot=? WHERE event_id=?`,
		[
			String(value.contentId),
			String(value.messageId),
			String(value.blockId),
			String(value.stream),
			Number(value.revision),
			Number(value.offset),
			Number(value.endOffset),
			JSON.stringify(snapshot),
			event.eventId,
		],
	);
	await sql.unsafe("UPDATE engine_attempts SET message_revision=? WHERE attempt_id=?", [
		event.eventId,
		event.attemptId,
	]);
	return value;
}

export async function runtimeMessageBaselines(
	sql: RuntimeSql,
	attemptId: string,
	cut: number,
	after: number,
	limit: number,
	work: RuntimeQueryWork,
): Promise<{ items: Record<string, unknown>[]; next: number | null }> {
	const rows = (await sql.unsafe(
		`SELECT message_id,block_id,stream,created_event_id FROM engine_runtime_messages
		WHERE attempt_id=? AND created_event_id<=? AND created_event_id>? ORDER BY created_event_id LIMIT ?`,
		[attemptId, cut, after, limit + 1],
	)) as MessageRow[];
	work.rows(rows.length);
	const items: Record<string, unknown>[] = [];
	for (const row of rows.slice(0, limit)) {
		const versions = (await sql.unsafe(
			`SELECT message_snapshot FROM engine_event_outbox WHERE attempt_id=? AND message_id=? AND message_block_id=? AND message_stream=?
			AND message_snapshot IS NOT NULL AND event_id<=? ORDER BY event_id DESC LIMIT 1`,
			[attemptId, row.message_id, row.block_id, row.stream, cut],
		)) as Array<{ message_snapshot: string }>;
		work.rows(versions.length);
		if (!versions[0]) throw new EngineTargetError("history_expired", "Message baseline is no longer retained");
		items.push(work.decode<Record<string, unknown>>(versions[0].message_snapshot));
	}
	return { items, next: rows.length > limit ? Number(rows[limit - 1].created_event_id) : null };
}

export async function runtimeMessageRange(
	sql: RuntimeSql,
	request: RuntimeAccess & { resource: Record<string, unknown>; offset: number; limit: number },
	work: RuntimeQueryWork,
): Promise<Record<string, unknown>> {
	const { resource } = request;
	const identity = await runtimeIdentity(sql, String(resource.agentInstanceRef), request);
	work.rows(1);
	const versions = (await sql.unsafe(
		`SELECT message_snapshot FROM engine_event_outbox WHERE message_content_id=? AND message_revision=?
		AND agent_instance_id=? AND attempt_id=? AND message_id=? AND message_block_id=? AND message_stream=? LIMIT 1`,
		[
			String(resource.contentId),
			Number(resource.revision),
			identity.agent_instance_id,
			String(resource.attemptId),
			String(resource.messageId),
			String(resource.blockId),
			String(resource.stream),
		],
	)) as Array<{ message_snapshot: string }>;
	work.rows(versions.length);
	if (!versions[0]) throw new EngineTargetError("history_expired", "Message resource version is not retained");
	const snapshot = work.decode<{ totalBytes: number }>(versions[0].message_snapshot);
	if (snapshot.totalBytes !== resource.bytes || request.offset > snapshot.totalBytes)
		throw new EngineTargetError("stale_target", "Message byte range is outside its immutable version");
	const starts = (await sql.unsafe(
		`SELECT message_offset FROM engine_event_outbox WHERE message_content_id=?
		AND message_offset<=? AND message_end_offset>message_offset ORDER BY message_offset DESC,event_id DESC LIMIT 1`,
		[String(resource.contentId), request.offset],
	)) as Array<{ message_offset: number }>;
	work.rows(starts.length);
	const rows = (await sql.unsafe(
		`SELECT payload,message_offset,message_end_offset FROM engine_event_outbox WHERE message_content_id=?
		AND message_offset>=? AND message_offset<? AND message_end_offset>message_offset AND message_revision<=? ORDER BY message_offset,event_id LIMIT ?`,
		[
			String(resource.contentId),
			Number(starts[0]?.message_offset ?? request.offset),
			Math.min(snapshot.totalBytes, request.offset + request.limit + 4),
			Number(resource.revision),
			runtimeLimits.httpPageRecords,
		],
	)) as Array<{ payload: string; message_offset: number; message_end_offset: number }>;
	work.rows(rows.length);
	const chunks: Buffer[] = [];
	let end = request.offset;
	for (const row of rows) {
		const payload = work.decode<{ text: string }>(row.payload);
		const content = Buffer.from(payload.text);
		const start = Math.max(0, request.offset - Number(row.message_offset));
		if (end < Number(row.message_offset))
			throw new EngineTargetError("history_expired", "Message content has a retention gap");
		let take = Math.min(content.length, request.offset + request.limit - Number(row.message_offset));
		while (take > start && take < content.length && (content[take] & 0xc0) === 0x80) take--;
		if (
			(start < content.length && (content[start] & 0xc0) === 0x80) ||
			(take === start && end === request.offset && snapshot.totalBytes > request.offset)
		)
			throw new EngineTargetError("invalid_request", "Message range must start and end on UTF-8 boundaries");
		if (take > start) {
			chunks.push(content.subarray(start, take));
			end = Number(row.message_offset) + take;
		}
		if (take < content.length || end >= request.offset + request.limit) break;
	}
	if (end === request.offset && end < snapshot.totalBytes)
		throw new EngineTargetError("history_expired", "Message range has no retained data");
	const result = {
		resource,
		offset: request.offset,
		nextOffset: end < snapshot.totalBytes ? end : null,
		contentBase64: Buffer.concat(chunks).toString("base64"),
	};
	work.finish(result, 1);
	validateRuntimeValue("httpRange", result);
	return result;
}
