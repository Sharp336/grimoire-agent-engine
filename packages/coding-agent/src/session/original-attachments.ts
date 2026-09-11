import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBlobsDir, prompt, TempDir } from "@oh-my-pi/pi-utils";
import originalAttachmentsPrompt from "../prompts/system/original-attachments.md" with { type: "text" };
import { BLOB_RANGE_BYTES, BlobStore } from "./blob-store";
import { copyOriginalAttachments, type SessionEntry, type SessionMessageIdentity } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Provider-only file handles. The canonical user caption remains unchanged. */
export function withOriginalAttachmentNotices(
	messages: AgentMessage[],
	entries: readonly SessionEntry[],
	identityFor: (message: AgentMessage) => SessionMessageIdentity | undefined,
): AgentMessage[] {
	const retained = new Map<AgentMessage, { identity: SessionMessageIdentity; entryId: string }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user" || !entry.originalAttachments?.length) continue;
		retained.set(entry.message, { identity: entry, entryId: entry.id });
	}
	let decorated: AgentMessage[] | undefined;
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "user") continue;
		const saved = retained.get(message);
		const identity = identityFor(message) ?? saved?.identity;
		if (!identity?.originalAttachments?.length) continue;
		const target = identity.clientMessageId
			? `message/${encodeURIComponent(identity.clientMessageId)}`
			: saved
				? `entry/${encodeURIComponent(saved.entryId)}`
				: undefined;
		if (!target) throw new Error("Original attachment message has no stable identity");
		const attachments = copyOriginalAttachments(identity.originalAttachments).map((attachment, index) => ({
			uri: `attachment://original/${target}/${index}`,
			name: JSON.stringify(attachment.name),
			mediaType: attachment.mediaType,
			bytes: attachment.bytes,
		}));
		decorated ??= messages.slice();
		decorated[messageIndex] = {
			...message,
			content: [
				...(typeof message.content === "string"
					? [{ type: "text" as const, text: message.content }]
					: message.content),
				{ type: "text" as const, text: prompt.render(originalAttachmentsPrompt, { attachments }) },
			],
		};
	}
	return decorated ?? messages;
}

/** Expose a verified disposable copy only for the duration of a normal read-tool operation. */
export async function withOriginalAttachment<T>(
	manager: Pick<SessionManager, "getBranch">,
	uri: string,
	read: (filePath: string) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const match = /^attachment:\/\/original\/(message|entry)\/([^/?#]+)\/(0|[1-9]\d*)$/.exec(uri);
	if (!match) throw new Error("Invalid original attachment URL");
	const identity = decodeURIComponent(match[2]);
	const index = Number(match[3]);
	if (!Number.isSafeInteger(index)) throw new Error("Invalid original attachment index");
	const find = () => {
		const matches = manager
			.getBranch()
			.filter(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					(match[1] === "entry" ? entry.id === identity : entry.clientMessageId === identity),
			);
		if (matches.length > 1) throw new Error("Original attachment message identity is ambiguous");
		return matches[0];
	};
	const entry = find();
	if (entry?.type !== "message" || entry.message.role !== "user" || !entry.originalAttachments)
		throw new Error("Original attachment does not belong to this session branch");
	const attachment = copyOriginalAttachments(entry.originalAttachments)[index];
	if (!attachment) throw new Error("Original attachment index is not retained");
	const suffix = path.extname(attachment.name).toLowerCase();
	using temp = TempDir.createSync("@omp-original-read-");
	const filePath = path.join(temp.path(), `original${/^\.[a-z0-9]{1,16}$/.test(suffix) ? suffix : ".bin"}`);
	const output = await fs.open(filePath, "wx");
	const blobs = new BlobStore(getBlobsDir());
	const digest = new Bun.SHA256();
	try {
		let offset = 0;
		do {
			signal?.throwIfAborted();
			const range = await blobs.getRange(attachment.contentHash.slice(7), offset, BLOB_RANGE_BYTES);
			if (!range || range.totalBytes !== attachment.bytes || (offset < attachment.bytes && !range.data.length))
				throw new Error("Original attachment bytes changed or are unavailable");
			await output.writeFile(range.data);
			digest.update(range.data);
			offset += range.data.length;
		} while (offset < attachment.bytes);
	} finally {
		await output.close();
	}
	if (`sha256:${digest.digest("hex")}` !== attachment.contentHash)
		throw new Error("Original attachment SHA-256 does not match its retained identity");
	signal?.throwIfAborted();
	const current = find();
	if (
		current?.type !== "message" ||
		current.message.role !== "user" ||
		JSON.stringify(copyOriginalAttachments(current.originalAttachments)[index]) !== JSON.stringify(attachment)
	)
		throw new Error("Original attachment session branch changed during read");
	return await read(filePath);
}
