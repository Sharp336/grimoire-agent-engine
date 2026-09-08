import { type EngineInboxItem, EngineTargetError } from "./contracts";
import { RuntimeQueryError, RuntimeQueryWork, type RuntimeSql, runtimeIdentity } from "./runtime-projection";
import { type RuntimeAccess, runtimeLimits, validateRuntimeValue } from "./runtime-protocol";

export const RUNTIME_QUEUE_SCHEMA = [
	"CREATE INDEX engine_inbox_agent_page_idx ON engine_inbox_items(agent_instance_id,disposition,position,queue_id)",
] as const;

export interface RuntimeQueueRequest extends RuntimeAccess {
	agentInstanceRef: string;
	queueId?: string;
	cursor?: string;
	limit?: number;
}

type QueueField = "deliveryPayload" | "annotation" | "sender";
type QueueText = Partial<Record<QueueField, string>> & { deliveryPayload: string };
type QueueBytes = Record<QueueField, number>;
type PublicQueueFields = Pick<
	EngineInboxItem,
	| "queueId"
	| "sourceType"
	| "sourceEventId"
	| "sender"
	| "deliveryPayload"
	| "annotation"
	| "deliverAt"
	| "wakeIntent"
	| "position"
	| "disposition"
	| "revision"
	| "createdAt"
	| "updatedAt"
>;

const fields = ["deliveryPayload", "annotation", "sender"] as const;
const columns = { deliveryPayload: "i.delivery_payload", annotation: "i.annotation", sender: "s.sender" } as const;
const resourceKeys = {
	deliveryPayload: "resource",
	annotation: "annotationResource",
	sender: "senderResource",
} as const;

interface QueueMetadata {
	queue_id: string;
	source_event_id: string;
	source_type: EngineInboxItem["sourceType"];
	deliver_at: number | null;
	wake_intent: number;
	position: number;
	disposition: EngineInboxItem["disposition"];
	revision: number;
	created_at: number;
	updated_at: number;
	deliveryPayload: number;
	annotation: number | null;
	sender: number | null;
	identity_bytes: number;
}

const metadataSelect = `SELECT i.queue_id,SUBSTR(i.source_event_id,1,${runtimeLimits.bulkPreviewBytes}) AS source_event_id,
	s.source_type,i.deliver_at,i.wake_intent,i.position,i.disposition,i.revision,i.created_at,i.updated_at,
	LENGTH(CAST(i.delivery_payload AS BLOB)) AS deliveryPayload,LENGTH(CAST(i.annotation AS BLOB)) AS annotation,
	LENGTH(CAST(s.sender AS BLOB)) AS sender,LENGTH(CAST(i.source_event_id AS BLOB)) AS identity_bytes
	FROM engine_inbox_items i JOIN engine_inbox_sources s ON s.source_event_id=i.source_event_id`;

function utf8Prefix(bytes: Uint8Array, maximum = bytes.length): string {
	let end = Math.min(maximum, bytes.length);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let removed = 0; removed < 4; removed++, end--) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			if (end === 0) break;
		}
	}
	throw new EngineTargetError("invalid_request", "Stored queue text is not UTF-8");
}

function prefix(text: string, maximum: number): string {
	let end = Math.min(maximum, text.length);
	const last = text.charCodeAt(end - 1);
	if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
	return utf8Prefix(Buffer.from(text.slice(0, end)), maximum);
}

/** A public projection only; canonical queue source/body and delivery semantics are retained. */
export function publicRuntimeQueueItem(
	agentInstanceRef: string,
	item: PublicQueueFields,
	lengths?: QueueBytes,
): Record<string, unknown> {
	const text: QueueText = { deliveryPayload: item.deliveryPayload };
	if (item.annotation !== undefined) text.annotation = item.annotation;
	if (item.sender !== undefined) text.sender = item.sender;
	const bytes = lengths ?? {
		deliveryPayload: Buffer.byteLength(text.deliveryPayload),
		annotation: Buffer.byteLength(text.annotation ?? ""),
		sender: Buffer.byteLength(text.sender ?? ""),
	};
	const result: Record<string, unknown> = {
		queueId: item.queueId,
		sourceType: item.sourceType,
		...(item.sourceEventId ? { sourceEventId: item.sourceEventId } : {}),
		...(item.deliverAt !== undefined ? { deliverAt: item.deliverAt } : {}),
		wakeIntent: item.wakeIntent,
		position: item.position,
		disposition: item.disposition,
		revision: item.revision,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
	const truncated = fields.some(field => Buffer.byteLength(text[field] ?? "") < bytes[field]);
	if (
		truncated ||
		fields.reduce((sum, field) => sum + bytes[field], 0) > runtimeLimits.liveChangeBytes ||
		Buffer.byteLength(JSON.stringify({ ...result, ...text, partial: false })) >
			runtimeLimits.liveChangeBytes - 2 * runtimeLimits.bulkPreviewBytes
	) {
		for (const field of fields)
			if (text[field] !== undefined)
				text[field] = prefix(text[field]!, Math.floor(runtimeLimits.bulkPreviewBytes / 3));
		while (Buffer.byteLength(JSON.stringify(text)) > runtimeLimits.bulkPreviewBytes) {
			const longest = fields.reduce((left, right) =>
				(text[left]?.length ?? 0) > (text[right]?.length ?? 0) ? left : right,
			);
			text[longest] = prefix(text[longest]!, Math.floor(Buffer.byteLength(text[longest]!) / 2));
		}
	}
	Object.assign(result, text, { partial: Buffer.byteLength(text.deliveryPayload) < bytes.deliveryPayload });
	for (const field of fields) {
		if (Buffer.byteLength(text[field] ?? "") >= bytes[field]) continue;
		result[resourceKeys[field]] = {
			kind: "queue_item",
			agentInstanceRef,
			queueId: item.queueId,
			revision: item.revision,
			field,
			mediaType: "text/plain; charset=utf-8",
			bytes: bytes[field],
		};
	}
	validateRuntimeValue("queueItem", result);
	return result;
}

async function readItem(
	sql: RuntimeSql,
	agentInstanceRef: string,
	row: QueueMetadata,
	work: RuntimeQueryWork,
): Promise<Record<string, unknown>> {
	if (row.identity_bytes > runtimeLimits.bulkPreviewBytes)
		throw new RuntimeQueryError("restore_budget", "Queue source identity exceeds the public metadata bound", {
			...work.value,
		});
	const lengths: QueueBytes = {
		deliveryPayload: Number(row.deliveryPayload),
		annotation: Number(row.annotation ?? 0),
		sender: Number(row.sender ?? 0),
	};
	const total = fields.reduce((sum, field) => sum + lengths[field], 0);
	const bound =
		total > runtimeLimits.liveChangeBytes - runtimeLimits.bulkPreviewBytes
			? Math.floor(runtimeLimits.bulkPreviewBytes / 3)
			: runtimeLimits.liveChangeBytes;
	const expected = fields.reduce((sum, field) => sum + Math.min(lengths[field], bound), 0);
	if (work.value.materializedBytes + expected > work.remaining.materializedBytes)
		throw new RuntimeQueryError("restore_budget", "Queue materialization budget is exhausted", { ...work.value });
	const values = (await sql.unsafe(
		`SELECT ${fields.map(field => `SUBSTR(CAST(${columns[field]} AS BLOB),1,?) AS ${field}`).join(",")}
		FROM engine_inbox_items i JOIN engine_inbox_sources s ON s.source_event_id=i.source_event_id WHERE i.queue_id=?`,
		[bound, bound, bound, row.queue_id],
	)) as Array<Record<QueueField, Uint8Array | null>>;
	work.rows(values.length * 2);
	const value = values[0];
	for (const field of fields) work.value.materializedBytes += value[field]?.length ?? 0;
	work.check();
	return publicRuntimeQueueItem(
		agentInstanceRef,
		{
			queueId: row.queue_id,
			sourceEventId: row.source_event_id,
			sourceType: row.source_type,
			deliveryPayload: utf8Prefix(value.deliveryPayload!),
			...(value.annotation !== null ? { annotation: utf8Prefix(value.annotation) } : {}),
			...(value.sender !== null ? { sender: utf8Prefix(value.sender) } : {}),
			...(row.deliver_at !== null ? { deliverAt: Number(row.deliver_at) } : {}),
			wakeIntent: Boolean(row.wake_intent),
			position: Number(row.position),
			disposition: row.disposition,
			revision: Number(row.revision),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		},
		lengths,
	);
}

export async function readRuntimeQueue(
	sql: RuntimeSql,
	request: RuntimeQueueRequest,
): Promise<Record<string, unknown>> {
	const { principalId: _principal, authorizedAgentInstanceRefs: _refs, ...read } = request;
	validateRuntimeValue("queueReadRequest", read);
	const work = new RuntimeQueryWork({
		bytes: runtimeLimits.httpPageBytes,
		changes: runtimeLimits.httpPageRecords,
		scannedRows: runtimeLimits.bootstrapScannedRows,
		materializedBytes: runtimeLimits.bootstrapMaterializedBytes,
		timeMs: runtimeLimits.bootstrapTimeoutMs,
	});
	const identity = await runtimeIdentity(sql, request.agentInstanceRef, request);
	work.rows(1);
	const revision = Number(identity.queue_revision);
	let after = { position: 0, queueId: "" };
	if (request.cursor) {
		try {
			const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as {
				agentInstanceRef: string;
				revision: number;
				position: number;
				queueId: string;
			};
			if (
				cursor.agentInstanceRef !== request.agentInstanceRef ||
				cursor.revision !== revision ||
				!Number.isSafeInteger(cursor.position) ||
				cursor.position < 0 ||
				typeof cursor.queueId !== "string"
			)
				throw new Error("identity");
			after = cursor;
		} catch {
			throw new EngineTargetError("stale_target", "Queue cursor changed identity or revision");
		}
	}
	const limit = request.queueId ? 1 : (request.limit ?? runtimeLimits.httpPageRecords);
	const rows = (await sql.unsafe(
		`${metadataSelect} WHERE i.agent_instance_id=? AND ${
			request.queueId ? "i.queue_id=?" : "i.disposition='pending' AND (i.position,i.queue_id)>(?,?)"
		}
		ORDER BY i.position,i.queue_id LIMIT ?`,
		[
			identity.agent_instance_id,
			...(request.queueId ? [request.queueId] : [after.position, after.queueId]),
			limit + 1,
		],
	)) as QueueMetadata[];
	work.rows(rows.length * 2);
	work.value.materializedBytes += Buffer.byteLength(JSON.stringify(rows));
	work.check();
	const items: Record<string, unknown>[] = [];
	let bytes = runtimeLimits.bulkPreviewBytes;
	for (const row of rows.slice(0, limit)) {
		const item = await readItem(sql, request.agentInstanceRef, row, work);
		const size = Buffer.byteLength(JSON.stringify(item));
		if (bytes + size > runtimeLimits.httpPageBytes) break;
		items.push(item);
		bytes += size + 1;
	}
	const last = items.at(-1);
	const result = {
		version: "1.0",
		agentInstanceRef: request.agentInstanceRef,
		queueRevision: revision,
		items,
		nextCursor:
			rows.length > items.length && last
				? Buffer.from(
						JSON.stringify({
							agentInstanceRef: request.agentInstanceRef,
							revision,
							position: last.position,
							queueId: last.queueId,
						}),
					).toString("base64url")
				: null,
		work: work.value,
	};
	work.finish(result, items.length);
	validateRuntimeValue("queuePage", result);
	return result;
}

export async function runtimeQueueRange(
	sql: RuntimeSql,
	request: RuntimeAccess & { resource: Record<string, unknown>; offset: number; limit: number },
	work: RuntimeQueryWork,
): Promise<Record<string, unknown>> {
	const resource = request.resource;
	const identity = await runtimeIdentity(sql, String(resource.agentInstanceRef), request);
	work.rows(1);
	const column = columns[resource.field as QueueField];
	if (!column) throw new EngineTargetError("invalid_request", "Unknown queue resource field");
	const rows = (await sql.unsafe(
		`SELECT i.revision,LENGTH(CAST(${column} AS BLOB)) AS bytes
		FROM engine_inbox_items i JOIN engine_inbox_sources s ON s.source_event_id=i.source_event_id
		WHERE i.agent_instance_id=? AND i.queue_id=?`,
		[identity.agent_instance_id, String(resource.queueId)],
	)) as Array<{ revision: number; bytes: number | null }>;
	work.rows(rows.length * 2);
	const row = rows[0];
	if (
		!row ||
		row.bytes === null ||
		Number(row.revision) !== resource.revision ||
		Number(row.bytes) !== resource.bytes ||
		request.offset > Number(row.bytes)
	)
		throw new EngineTargetError("stale_target", "Queue resource identity, revision or range changed");
	const chunks = (await sql.unsafe(
		`SELECT SUBSTR(CAST(${column} AS BLOB),?,?) AS chunk
		FROM engine_inbox_items i JOIN engine_inbox_sources s ON s.source_event_id=i.source_event_id WHERE i.queue_id=?`,
		[request.offset + 1, request.limit, String(resource.queueId)],
	)) as Array<{ chunk: Uint8Array }>;
	work.rows(chunks.length * 2);
	const stored = Buffer.from(chunks[0].chunk);
	work.value.materializedBytes += stored.length;
	work.check();
	if (stored.length && (stored[0] & 0xc0) === 0x80)
		throw new EngineTargetError("invalid_request", "Queue range must start on a UTF-8 boundary");
	const bytes = Buffer.from(utf8Prefix(stored));
	if (!bytes.length && request.offset < Number(row.bytes))
		throw new EngineTargetError("invalid_request", "Queue range limit cannot hold the next UTF-8 codepoint");
	const end = request.offset + bytes.length;
	const result = {
		resource,
		offset: request.offset,
		nextOffset: end < Number(row.bytes) ? end : null,
		contentBase64: bytes.toString("base64"),
	};
	work.finish(result, 1);
	validateRuntimeValue("httpRange", result);
	return result;
}
