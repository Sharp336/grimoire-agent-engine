import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isEnoent, logger, parseImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";
import { BLOB_RANGE_BYTES, type BlobPublication, BlobSourceMismatchError, type BlobStore } from "../session/blob-store";
import { copyOriginalAttachments, type SessionOriginalAttachment } from "../session/session-entries";
import { storageCanonicalJson } from "../session/storage-client";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { type EngineAttachmentDescriptor, type EngineMessageAttachments, EngineTargetError } from "./contracts";
import { runtimeLimits, validateRuntimeValue } from "./runtime-protocol";
import type { RuntimeRecords } from "./runtime-records";

export interface EngineAttachment extends EngineAttachmentDescriptor {}

export interface EngineAttachmentStageRequest extends EngineAttachment {
	offset: number;
	contentBase64: string;
}

/** C5 `ready`: the one Rocks row that owns an uploaded body until it is consumed, removed or expires. */
interface ReadyUpload {
	subtype: "blob_upload";
	state: "ready";
	owner_hash: string;
	attachment: EngineAttachment;
	ready_at: number;
}

/** A `pending` upload (only `<root>/<key>/payload.bin`) older than this is abandoned. */
const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** How often staging traffic also sweeps abandoned pending uploads between Engine restarts. */
const PENDING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function invalid(message: string): never {
	throw new EngineTargetError("invalid_request", message);
}

function attachmentOwner(principalId: string): void {
	if (typeof principalId !== "string" || !principalId.trim() || principalId.length > 1024)
		invalid("An authenticated attachment owner is required");
}

export function attachmentUploadKey(principalId: string, uploadId: string): { key: string; ownerHash: string } {
	attachmentOwner(principalId);
	validateRuntimeValue("id", uploadId);
	const ownerHash = new Bun.SHA256().update(principalId).digest("hex");
	return { ownerHash, key: new Bun.SHA256().update(`${ownerHash}\0${uploadId}`).digest("hex") };
}

/** Validate and snapshot before any await. Order is part of message identity, not a set. */
export function messageAttachmentReferences(value: EngineMessageAttachments): EngineMessageAttachments {
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).some(key => !["principalId", "uploadIds"].includes(key))
	)
		invalid("Invalid message attachment references");
	attachmentOwner(value.principalId);
	if (!Array.isArray(value.uploadIds) || !value.uploadIds.length)
		invalid("Message attachment references must contain upload IDs");
	if (value.uploadIds.length > runtimeLimits.maxAttachmentsPerMessage)
		throw new EngineTargetError(
			"payload_too_large",
			`A message can carry at most ${runtimeLimits.maxAttachmentsPerMessage} attachments`,
		);
	// 128 schema-bounded IDs (<= 200 ASCII chars) stay far below the command byte budget.
	const seen = new Set<string>();
	for (const uploadId of value.uploadIds) {
		validateRuntimeValue("id", uploadId);
		if (seen.has(uploadId)) invalid("Message attachment references contain a duplicate upload ID");
		seen.add(uploadId);
	}
	return { principalId: value.principalId, uploadIds: [...value.uploadIds] };
}

export function attachmentIdentity(value: EngineAttachment): EngineAttachment {
	if (!value || typeof value !== "object") invalid("Attachment identity is required");
	for (const id of [value.uploadId, value.clientMessageId]) validateRuntimeValue("id", id);
	if (
		typeof value.name !== "string" ||
		!value.name.trim() ||
		value.name.length > 255 ||
		/[\x00-\x1f\x7f/\\]/.test(value.name)
	)
		invalid("Attachment name must be a filename, not a path");
	if (
		typeof value.mediaType !== "string" ||
		value.mediaType.length > 128 ||
		!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mediaType)
	)
		invalid("Invalid attachment media type");
	if (
		!Number.isSafeInteger(value.bytes) ||
		value.bytes < 0 ||
		typeof value.contentHash !== "string" ||
		value.contentHash.length !== 71 ||
		!/^sha256:[a-f0-9]{64}$/.test(value.contentHash)
	)
		invalid("Invalid attachment size or SHA-256");
	return {
		uploadId: value.uploadId,
		clientMessageId: value.clientMessageId,
		name: value.name,
		mediaType: value.mediaType,
		bytes: value.bytes,
		contentHash: value.contentHash,
	};
}

/**
 * Upload lifecycle (C5). `pending` is only `<root>/<key>/payload.bin`; `ready` is only the Rocks row
 * `metadata blob-upload:<key>`, which owns the published body until the receiving owner consumes it,
 * the draft is removed, or the storage owner expires it. One Engine owns this directory; the
 * authenticated principal comes from ClientHost, never from a file path.
 */
export class EngineAttachmentUploads {
	#lanes = new Map<string, Promise<void>>();
	#sweptAt = 0;
	constructor(
		readonly root: string,
		readonly blobs: BlobStore,
		readonly records: RuntimeRecords,
	) {}

	async #ready(key: string, ownerHash: string): Promise<ReadyUpload | undefined> {
		const row = (await this.records.get("metadata", `blob-upload:${key}`, true)).value as ReadyUpload | null;
		if (!row) return undefined;
		if (row.subtype !== "blob_upload" || row.state !== "ready" || row.owner_hash !== ownerHash)
			throw new EngineTargetError("stale_target", "Attachment identity changed or was removed");
		return { ...row, attachment: attachmentIdentity(row.attachment) };
	}

	/** Remove pending uploads abandoned for 24 h and their message admission entries; lists only those roots. */
	async sweepAbandoned(now = Date.now()): Promise<void> {
		this.#sweptAt = now;
		const lstat = (file: string) =>
			fs.promises.lstat(file).catch(error => {
				if (isEnoent(error)) return undefined;
				throw error;
			});
		for (const root of [this.root, `${this.root}-messages`]) {
			let entries: string[];
			try {
				entries = await fs.promises.readdir(root);
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const uploads = root === this.root;
			for (const name of entries) {
				if (!/^[a-f0-9]{64}$/.test(name)) continue;
				const dir = path.join(root, name);
				await this.#lane(uploads ? name : dir, async () => {
					const stat = await lstat(dir);
					if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
					// A pending upload ages from its last written chunk, not from when its directory appeared.
					const payload = uploads ? await lstat(path.join(dir, "payload.bin")) : undefined;
					if (now - (payload?.mtimeMs ?? stat.mtimeMs) < PENDING_UPLOAD_TTL_MS) return;
					if (uploads) await this.#discard(dir);
					else await fs.promises.rm(dir, { recursive: true, force: true });
				});
			}
		}
	}

	#key(principalId: string, uploadId: string): { key: string; ownerHash: string } {
		return attachmentUploadKey(principalId, uploadId);
	}

	async #lane<T>(key: string, action: () => Promise<T>): Promise<T> {
		const previous = this.#lanes.get(key) ?? Promise.resolve();
		const result = previous.then(action);
		const settled = result.then(
			() => {},
			() => {},
		);
		this.#lanes.set(key, settled);
		try {
			return await result;
		} finally {
			if (this.#lanes.get(key) === settled) this.#lanes.delete(key);
		}
	}

	async #directory(key: string, create: boolean): Promise<string> {
		const dir = path.join(this.root, key);
		for (const current of [this.root, dir]) {
			if (create) await fs.promises.mkdir(current, { recursive: true });
			const stat = await fs.promises.lstat(current);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new EngineTargetError("source_unavailable", "Attachment staging directory is unsafe");
		}
		return dir;
	}

	/** Drop one upload directory: its only entry is `payload.bin`. */
	async #discard(dir: string): Promise<void> {
		await fs.promises.unlink(path.join(dir, "payload.bin")).catch(error => {
			if (!isEnoent(error)) throw error;
		});
		await fs.promises.rmdir(dir).catch(error => {
			if (!isEnoent(error)) throw error;
		});
	}

	async #file(file: string, create: boolean): Promise<fs.promises.FileHandle> {
		let before: fs.Stats | undefined;
		try {
			before = await fs.promises.lstat(file);
		} catch (error) {
			if (!create || !isEnoent(error)) throw error;
		}
		if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error("Attachment file is unsafe");
		const flags =
			(create ? fs.constants.O_RDWR | fs.constants.O_CREAT : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0);
		const handle = await fs.promises.open(file, flags, 0o600);
		try {
			const opened = await handle.stat();
			const current = await fs.promises.lstat(file);
			if (
				!opened.isFile() ||
				current.isSymbolicLink() ||
				opened.dev !== current.dev ||
				opened.ino !== current.ino ||
				(before && (before.dev !== opened.dev || before.ino !== opened.ino))
			)
				throw new Error("Attachment file changed");
			return handle;
		} catch (error) {
			await handle.close();
			throw error;
		}
	}

	/** Uploads staged per owner and message; kept beside `root`, whose entries are upload directories only. */
	#messageIndex(ownerHash: string, clientMessageId: string): string {
		const id = new Bun.SHA256().update(`${ownerHash}\0${clientMessageId}`).digest("hex");
		return path.join(`${this.root}-messages`, id);
	}

	/** Count a new upload against its message before its first chunk is staged. */
	async #admit(ownerHash: string, clientMessageId: string, key: string): Promise<void> {
		const index = this.#messageIndex(ownerHash, clientMessageId);
		await this.#lane(index, async () => {
			await fs.promises.mkdir(index, { recursive: true });
			const staged = await fs.promises.readdir(index);
			if (staged.includes(key)) return;
			if (staged.length >= runtimeLimits.maxAttachmentsPerMessage)
				throw new EngineTargetError(
					"payload_too_large",
					`A message can carry at most ${runtimeLimits.maxAttachmentsPerMessage} attachments`,
				);
			await fs.promises.writeFile(path.join(index, key), "");
		});
	}

	/**
	 * Publish a complete `payload.bin` (C5): one streaming hash and a link under the per-hash lock,
	 * unlink the staged name, commit the `ready` row, then release the intent pin. A torn file is
	 * discarded so the client uploads it again instead of retrying the last chunk forever.
	 */
	async #finalize(
		dir: string,
		key: string,
		ownerHash: string,
		attachment: EngineAttachment,
		signal?: AbortSignal,
	): Promise<void> {
		const payload = path.join(dir, "payload.bin");
		let publication: BlobPublication;
		try {
			publication = await this.blobs.publish(
				{ file: payload, hash: attachment.contentHash.slice(7), bytes: attachment.bytes },
				{ signal },
			);
		} catch (error) {
			if (!(error instanceof BlobSourceMismatchError)) throw error;
			await this.#discard(dir);
			throw new EngineTargetError(
				"source_unavailable",
				"Uploaded bytes do not match their declared size and SHA-256 hash; upload the file again",
			);
		}
		try {
			await this.#discard(dir);
			await this.records.mutate(`blob-upload:${key}`, async tx => {
				if (await tx.get("metadata", `blob-upload:${key}`))
					throw new EngineTargetError("stale_target", "Attachment upload was already completed");
				const ready: ReadyUpload = {
					subtype: "blob_upload",
					state: "ready",
					owner_hash: ownerHash,
					attachment,
					ready_at: Date.now(),
				};
				await tx.put("metadata", `blob-upload:${key}`, ready);
			});
		} catch (error) {
			await publication.abandon();
			throw error;
		}
		await publication.release();
	}

	async stage(
		principalId: string,
		request: EngineAttachmentStageRequest,
		signal?: AbortSignal,
	): Promise<{
		attachment: EngineAttachment;
		nextOffset: number;
		complete: boolean;
	}> {
		const attachment = attachmentIdentity(request);
		const { key, ownerHash } = this.#key(principalId, attachment.uploadId);
		if (attachment.bytes > runtimeLimits.maxAttachmentBytes)
			throw new EngineTargetError(
				"payload_too_large",
				`Attachment exceeds the ${runtimeLimits.maxAttachmentBytes / 1024 / 1024} MiB file limit`,
			);
		if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > attachment.bytes)
			invalid("Attachment offset is outside the upload");
		if (
			typeof request.contentBase64 !== "string" ||
			request.contentBase64.length > Math.ceil(BLOB_RANGE_BYTES / 3) * 4
		)
			invalid("Attachment chunk exceeds the byte budget");
		const chunk = Buffer.from(request.contentBase64, "base64");
		if (
			chunk.toString("base64") !== request.contentBase64 ||
			chunk.length > BLOB_RANGE_BYTES ||
			(chunk.length === 0 && attachment.bytes !== 0) ||
			request.offset + chunk.length > attachment.bytes
		)
			invalid("Attachment chunk is not a canonical bounded range");
		const offset = request.offset;
		if (Date.now() - this.#sweptAt >= PENDING_SWEEP_INTERVAL_MS)
			void this.sweepAbandoned().catch(error => {
				logger.warn("Abandoned attachment upload sweep failed", { error: String(error) });
			});
		return this.#lane(key, async () => {
			signal?.throwIfAborted();
			const ready = await this.#ready(key, ownerHash);
			if (ready) {
				if (storageCanonicalJson(ready.attachment) !== storageCanonicalJson(attachment))
					throw new EngineTargetError("stale_target", "Attachment identity changed or was removed");
				// A retried chunk of a completed upload must equal the published bytes.
				const range = await this.blobs.getRange(attachment.contentHash.slice(7), offset, Math.max(1, chunk.length));
				if (!range || range.totalBytes !== attachment.bytes || !range.data.equals(chunk))
					throw new EngineTargetError("stale_target", "Attachment retry differs from the completed upload");
				return { attachment, nextOffset: attachment.bytes, complete: true };
			}
			let dir: string;
			try {
				dir = await this.#directory(key, false);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				if (offset !== 0)
					throw new EngineTargetError("stale_target", "Attachment upload must start at offset zero");
				await this.#admit(ownerHash, attachment.clientMessageId, key);
				dir = await this.#directory(key, true);
			}
			const handle = await this.#file(path.join(dir, "payload.bin"), true);
			let currentBytes: number;
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > attachment.bytes) throw new Error("Attachment staging file is unsafe");
				currentBytes = stat.size;
				if (offset > currentBytes)
					throw new EngineTargetError("stale_target", `Attachment expects offset ${currentBytes}`);
				let written = Math.min(chunk.length, currentBytes - offset);
				if (offset < currentBytes) {
					const previous = Buffer.alloc(written);
					const { bytesRead } = await handle.read(previous, 0, previous.length, offset);
					if (bytesRead !== written || !previous.equals(chunk.subarray(0, written)))
						throw new EngineTargetError("stale_target", "Attachment chunk conflicts with staged bytes");
				}
				if (written < chunk.length) {
					signal?.throwIfAborted();
					while (written < chunk.length) {
						const { bytesWritten } = await handle.write(chunk, written, chunk.length - written, offset + written);
						if (!bytesWritten) throw new Error("Attachment write made no progress");
						written += bytesWritten;
					}
					// No per-chunk fsync: publication hashes and syncs the staged bytes once before linking them,
					// so an OS crash that tears staged bytes fails that SHA-256 check instead of publishing them.
					currentBytes = offset + chunk.length;
				}
			} finally {
				await handle.close();
			}
			if (currentBytes === attachment.bytes) await this.#finalize(dir, key, ownerHash, attachment, signal);
			return { attachment, nextOffset: currentBytes, complete: currentBytes === attachment.bytes };
		});
	}

	async resolveMessage(
		clientMessageId: string,
		references: EngineMessageAttachments,
		signal?: AbortSignal,
	): Promise<EngineAttachment[]> {
		validateRuntimeValue("id", clientMessageId);
		const captured = messageAttachmentReferences(references);
		const attachments: EngineAttachment[] = [];
		for (const uploadId of captured.uploadIds) {
			signal?.throwIfAborted();
			attachments.push(await this.resolve(captured.principalId, clientMessageId, uploadId));
		}
		signal?.throwIfAborted();
		return attachments;
	}

	async resolve(principalId: string, clientMessageId: string, uploadId: string): Promise<EngineAttachment> {
		const { key, ownerHash } = this.#key(principalId, uploadId);
		return this.#lane(key, async () => {
			const ready = await this.#ready(key, ownerHash);
			if (!ready)
				throw new EngineTargetError(
					"attachment_expired",
					"Attachment upload is not ready or has expired; attach the file again",
				);
			const { attachment } = ready;
			if (attachment.uploadId !== uploadId || attachment.clientMessageId !== clientMessageId)
				throw new EngineTargetError("stale_target", "Attachment is not ready for this message");
			const range = await this.blobs.getRange(attachment.contentHash.slice(7), 0, 1);
			if (!range || range.totalBytes !== attachment.bytes)
				throw new EngineTargetError("source_unavailable", "Attachment bytes are no longer retained");
			return attachment;
		});
	}

	/**
	 * Images reach the model inline; every file also travels as an original attachment the read tool opens via
	 * attachment://. Delivery ends the message's upload admission, so its index entry goes with it.
	 */
	async prepareForMessage(
		clientMessageId: string,
		references: EngineMessageAttachments,
		signal?: AbortSignal,
		accepted?: readonly EngineAttachment[],
	): Promise<{ images: ImageContent[]; originalAttachments: SessionOriginalAttachment[] }> {
		const attachments = accepted
			? accepted.map(attachmentIdentity)
			: await this.resolveMessage(clientMessageId, references, signal);
		if (
			accepted &&
			(attachments.length !== references.uploadIds.length ||
				attachments.some(
					(item, index) =>
						item.uploadId !== references.uploadIds[index] || item.clientMessageId !== clientMessageId,
				))
		)
			throw new EngineTargetError("stale_target", "Accepted attachment snapshot differs from the queue");
		const originalAttachments = copyOriginalAttachments(attachments);
		let total = 0;
		for (const attachment of attachments) {
			if (!SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mediaType)) continue;
			total += attachment.bytes;
			if (total > MAX_IMAGE_INPUT_BYTES)
				throw new EngineTargetError("payload_too_large", "Message images exceed the model image-input byte budget");
		}
		const images: ImageContent[] = [];
		for (const attachment of attachments) {
			if (!SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mediaType)) continue;
			signal?.throwIfAborted();
			const data = Buffer.allocUnsafe(attachment.bytes);
			let offset = 0;
			let present: boolean;
			try {
				present = await this.blobs.readVerified(
					attachment.contentHash.slice(7),
					attachment.bytes,
					chunk => {
						offset += chunk.copy(data, offset);
					},
					signal,
				);
			} catch {
				signal?.throwIfAborted();
				throw new EngineTargetError(
					"source_unavailable",
					"Attachment SHA-256 no longer matches its uploaded bytes",
				);
			}
			if (!present) throw new EngineTargetError("source_unavailable", "Attachment bytes are no longer retained");
			if (parseImageMetadata(data)?.mimeType !== attachment.mediaType)
				throw new EngineTargetError("invalid_request", "Attachment bytes do not match the declared image type");
			images.push({ type: "image", mimeType: attachment.mediaType, data: data.toString("base64") });
		}
		signal?.throwIfAborted();
		const index = this.#messageIndex(new Bun.SHA256().update(references.principalId).digest("hex"), clientMessageId);
		await this.#lane(index, () => fs.promises.rm(index, { recursive: true, force: true }));
		return { images, originalAttachments };
	}

	/** Remove a draft: its pending bytes or its `ready` row. A body the row owned is left to the storage owner. */
	async remove(principalId: string, uploadId: string): Promise<{ removed: true }> {
		const { key } = this.#key(principalId, uploadId);
		return this.#lane(key, async () => {
			await this.#discard(path.join(this.root, key));
			// A pending upload does not record its message, so free its admission slot in every open message.
			// Open messages are bounded: delivery and the 24 h sweep drop their indexes.
			const indexes = `${this.root}-messages`;
			const messages = await fs.promises.readdir(indexes).catch(error => {
				if (isEnoent(error)) return [];
				throw error;
			});
			for (const message of messages) {
				const index = path.join(indexes, message);
				await this.#lane(index, () =>
					fs.promises.unlink(path.join(index, key)).catch(error => {
						if (!isEnoent(error)) throw error;
					}),
				);
			}
			// The key already binds the owner, so a row at this key is this owner's draft.
			await this.records.mutate(`blob-upload:${key}`, async tx => {
				if (await tx.get("metadata", `blob-upload:${key}`)) await tx.delete("metadata", `blob-upload:${key}`);
			});
			return { removed: true };
		});
	}
}
