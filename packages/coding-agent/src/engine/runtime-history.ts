import { type BlobStore, parseBlobRef } from "../session/blob-store";
import { copyOriginalAttachments, type SessionEntry, type SessionOriginalAttachment } from "../session/session-entries";
import type { HistoryLifecycleContext } from "./runtime-lifecycle";
import { runtimeLimits } from "./runtime-protocol";

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
