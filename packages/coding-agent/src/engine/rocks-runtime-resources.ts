import { getBlobsDir } from "@oh-my-pi/pi-utils";
import { BlobStore, parseBlobRef } from "../session/blob-store";
import { copyOriginalAttachments } from "../session/session-entries";
import type { StorageRuntimeIndex } from "../session/storage-protocol";
import { EngineTargetError } from "./contracts";
import { nativeEntry } from "./rocks-runtime-history";
import { type ProjectedEvent, projectionId, type RocksProjection } from "./rocks-runtime-projection";
import type { RocksInbox } from "./rocks-runtime-rows";
import { queryWork, type RocksEngineStore } from "./rocks-runtime-store";
import { runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
import type { RuntimeResourceRequest } from "./runtime-resources";

export async function runtimeResource(
	store: RocksEngineStore,
	request: RuntimeResourceRequest,
): Promise<Record<string, unknown>> {
	const { resource, offset, limit } = request;
	validateRuntimeValue("resourceReadRequest", { resource, offset, limit });
	const work = queryWork();
	const identity = await store.identity(String(resource.agentInstanceRef), request, work);
	if (typeof resource.attemptId === "string") await store.attempt(identity, resource.attemptId, work);
	let bytes: Buffer;
	let text = false;
	if (resource.kind === "message") {
		const page = await store.records.query(
			"event_message_revision" as StorageRuntimeIndex,
			[String(resource.contentId), Number(resource.revision)],
			undefined,
			1,
		);
		work.rows(page.records.length);
		const event = page.records[0]?.value as unknown as ProjectedEvent | undefined;
		const snapshot = event?.message_snapshot;
		if (
			!event ||
			event.agentInstanceId !== identity.agent_instance_id ||
			event.attemptId !== resource.attemptId ||
			snapshot?.messageId !== resource.messageId ||
			snapshot?.blockId !== resource.blockId ||
			snapshot?.stream !== resource.stream ||
			snapshot?.totalBytes !== resource.bytes
		)
			throw new EngineTargetError("stale_target", "Message resource changed identity or version");
		if (offset > Number(resource.bytes))
			throw new EngineTargetError("invalid_request", "Message range starts after EOF");
		const rows = await store.records.query(
			"event_message" as StorageRuntimeIndex,
			[String(resource.contentId)],
			undefined,
			runtimeLimits.httpPageRecords,
			[Math.max(-1, offset - runtimeLimits.liveChangeBytes), -1],
		);
		work.rows(rows.records.length);
		work.value.materializedBytes += Buffer.byteLength(JSON.stringify(rows));
		work.check();
		const chunks: Buffer[] = [];
		let end = offset;
		for (const raw of rows.records) {
			const row = raw.value as unknown as ProjectedEvent;
			if (Number(row.message_revision) > Number(resource.revision) || Number(row.message_end_offset) <= end)
				continue;
			if (Number(row.message_offset) > end)
				throw new EngineTargetError("history_expired", "Message content has a retention gap");
			const value = Buffer.from(String(row.payload?.text ?? ""));
			const start = end - Number(row.message_offset);
			if (value[start] !== undefined && (value[start] & 0xc0) === 0x80)
				throw new EngineTargetError("invalid_request", "Message range starts inside UTF-8 codepoint");
			let take = Math.min(value.length, offset + limit - Number(row.message_offset));
			while (take > start && take < value.length && (value[take] & 0xc0) === 0x80) take--;
			if (take > start) {
				chunks.push(value.subarray(start, take));
				end = Number(row.message_offset) + take;
			}
			if (take < value.length || end >= offset + limit) break;
		}
		if (end === offset && end < Number(resource.bytes))
			throw new EngineTargetError("invalid_request", "Message range cannot contain the next retained codepoint");
		const result = {
			resource,
			offset,
			nextOffset: end < Number(resource.bytes) ? end : null,
			contentBase64: Buffer.concat(chunks).toString("base64"),
		};
		work.finish(result, 1);
		validateRuntimeValue("httpRange", result);
		return result;
	} else if (resource.kind === "queue_item") {
		const row = await store.row<RocksInbox>("inbox", String(resource.queueId), work);
		if (
			!row ||
			row.agent_instance_id !== identity.agent_instance_id ||
			row.revision !== resource.revision ||
			!["deliveryPayload", "annotation", "sender"].includes(String(resource.field))
		)
			throw new EngineTargetError("stale_target", "Queue resource changed identity or revision");
		bytes = Buffer.from(String(row[resource.field as "deliveryPayload" | "annotation" | "sender"] ?? ""));
		text = true;
	} else if (resource.kind === "input") {
		const row = await store.row<RocksProjection>(
			"projection",
			projectionId("input", String(resource.attemptId), String(resource.inputId)),
			work,
		);
		if (
			!row?.body ||
			row.agent_instance_id !== identity.agent_instance_id ||
			row.value.revision !== resource.revision
		)
			throw new EngineTargetError("stale_target", "Input resource changed identity or revision");
		bytes = Buffer.from(JSON.stringify(row.body));
	} else if (["history_entry", "history_image", "history_attachment"].includes(String(resource.kind))) {
		const { entry } = await nativeEntry(
			store,
			identity.agent_instance_id,
			String(resource.entryId),
			String(resource.revision),
			String(resource.sessionId),
			typeof resource.attemptId === "string" ? resource.attemptId : undefined,
		);
		work.value.materializedBytes += Buffer.byteLength(JSON.stringify(entry));
		work.check();
		if (resource.kind === "history_entry") {
			if (resource.mediaType !== "application/json" || resource.contentHash !== undefined)
				throw new EngineTargetError("stale_target", "History descriptor differs from its native resource");
			bytes = Buffer.from(JSON.stringify(entry));
		} else {
			let hash: string | null;
			if (resource.kind === "history_attachment") {
				const message = entry.message as { role?: string } | undefined;
				if (entry.type !== "message" || message?.role !== "user")
					throw new EngineTargetError("stale_target", "Attachment is not owned by a user message");
				const attachment = copyOriginalAttachments(entry.originalAttachments)[Number(resource.attachmentIndex)];
				if (
					!attachment ||
					attachment.name !== resource.name ||
					attachment.mediaType !== resource.mediaType ||
					attachment.contentHash !== resource.contentHash ||
					attachment.bytes !== resource.bytes
				)
					throw new EngineTargetError("stale_target", "Original attachment descriptor changed");
				hash = attachment.contentHash.slice(7);
			} else {
				const content = (
					entry.message as { content?: Array<{ type: string; data?: string; mimeType?: string }> } | undefined
				)?.content;
				const block = Array.isArray(content) ? content[Number(resource.blockIndex)] : undefined;
				if (block?.type !== "image" || block.mimeType !== resource.mediaType || typeof block.data !== "string")
					throw new EngineTargetError("stale_target", "Native image descriptor changed");
				// Native history stores images only as blob references; the range reads the body, never the record.
				hash = parseBlobRef(block.data);
				if (!hash || resource.contentHash !== `sha256:${hash}`)
					throw new EngineTargetError("stale_target", "Native image content hash changed");
			}
			if (offset > Number(resource.bytes))
				throw new EngineTargetError("invalid_request", "Resource range starts after EOF");
			const range = await new BlobStore(getBlobsDir()).getRange(hash, offset, limit);
			if (!range) throw new EngineTargetError("history_expired", "Original resource bytes are unavailable");
			if (range.totalBytes !== resource.bytes || offset > range.totalBytes)
				throw new EngineTargetError("stale_target", "Original resource size changed");
			const result = {
				resource,
				offset,
				nextOffset: range.nextOffset,
				contentBase64: range.data.toString("base64"),
			};
			work.finish(result, 1);
			validateRuntimeValue("httpRange", result);
			return result;
		}
	} else throw new EngineTargetError("invalid_request", "Unknown resource kind");
	if (bytes.length !== resource.bytes || offset > bytes.length)
		throw new EngineTargetError("stale_target", "Resource size or byte range changed");
	let end = Math.min(bytes.length, offset + limit);
	if (text) {
		if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
			throw new EngineTargetError("invalid_request", "Text range starts inside UTF-8 codepoint");
		while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
		if (end === offset && end < bytes.length)
			throw new EngineTargetError("invalid_request", "Range cannot contain the next codepoint");
	}
	const result = {
		resource,
		offset,
		nextOffset: end < bytes.length ? end : null,
		contentBase64: bytes.subarray(offset, end).toString("base64"),
	};
	work.finish(result, 1);
	validateRuntimeValue("httpRange", result);
	return result;
}
