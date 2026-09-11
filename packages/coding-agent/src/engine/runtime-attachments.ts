import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isEnoent, parseImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";
import { BLOB_RANGE_BYTES, type BlobStore } from "../session/blob-store";
import { copyOriginalAttachments, type SessionOriginalAttachment } from "../session/session-entries";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { type EngineMessageAttachments, EngineTargetError } from "./contracts";
import { runtimeLimits, validateRuntimeValue } from "./runtime-protocol";

export interface EngineAttachment {
	uploadId: string;
	clientMessageId: string;
	name: string;
	mediaType: string;
	bytes: number;
	contentHash: string;
}

export interface EngineAttachmentStageRequest extends EngineAttachment {
	offset: number;
	contentBase64: string;
}

interface UploadManifest {
	version: 1;
	ownerHash: string;
	attachment: EngineAttachment;
	state: "pending" | "ready";
}

function invalid(message: string): never {
	throw new EngineTargetError("invalid_request", message);
}

function attachmentOwner(principalId: string): void {
	if (typeof principalId !== "string" || !principalId.trim() || principalId.length > 1024)
		invalid("An authenticated attachment owner is required");
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
	const seen = new Set<string>();
	let bytes = Buffer.byteLength(JSON.stringify({ principalId: value.principalId, uploadIds: [] }));
	for (const uploadId of value.uploadIds) {
		validateRuntimeValue("id", uploadId);
		if (seen.has(uploadId)) invalid("Message attachment references contain a duplicate upload ID");
		bytes += Buffer.byteLength(uploadId) + 2 + (seen.size ? 1 : 0);
		if (bytes > runtimeLimits.wsMessageBytes)
			throw new EngineTargetError(
				"payload_too_large",
				"Message attachment references exceed the command byte budget",
			);
		seen.add(uploadId);
	}
	return { principalId: value.principalId, uploadIds: [...value.uploadIds] };
}

function attachmentIdentity(value: EngineAttachment): EngineAttachment {
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

/** Temporary, restartable upload receipts. Bytes live only in the canonical BlobStore once ready.
 * One Engine owns this directory. Authenticated principal comes from ClientHost, never from a file path.
 */
export class EngineAttachmentUploads {
	#lanes = new Map<string, Promise<void>>();
	constructor(
		readonly root: string,
		readonly blobs: BlobStore,
	) {}

	#key(principalId: string, uploadId: string): { key: string; ownerHash: string } {
		attachmentOwner(principalId);
		validateRuntimeValue("id", uploadId);
		const ownerHash = new Bun.SHA256().update(principalId).digest("hex");
		return { ownerHash, key: new Bun.SHA256().update(`${ownerHash}\0${uploadId}`).digest("hex") };
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

	async #manifest(dir: string): Promise<UploadManifest> {
		const handle = await this.#file(path.join(dir, "manifest.json"), false);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid upload manifest");
			const buffer = Buffer.alloc(4097);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead !== stat.size) throw new Error("Upload manifest changed");
			const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as UploadManifest;
			if (
				value.version !== 1 ||
				!/^[a-f0-9]{64}$/.test(value.ownerHash) ||
				!["pending", "ready"].includes(value.state)
			)
				throw new Error("Invalid upload manifest");
			return {
				version: 1,
				ownerHash: value.ownerHash,
				attachment: attachmentIdentity(value.attachment),
				state: value.state,
			};
		} finally {
			await handle.close();
		}
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

	async #assertPresent(dir: string): Promise<void> {
		try {
			await fs.promises.lstat(path.join(dir, "removed"));
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		throw new EngineTargetError("stale_target", "Attachment was removed");
	}

	async #save(dir: string, manifest: UploadManifest): Promise<void> {
		const temporary = path.join(dir, `${crypto.randomUUID()}.manifest-tmp`);
		const handle = await fs.promises.open(temporary, "wx");
		try {
			await handle.writeFile(JSON.stringify(manifest));
			await handle.sync();
			await handle.close();
			await fs.promises.rename(temporary, path.join(dir, "manifest.json"));
		} finally {
			await handle.close();
			await fs.promises.unlink(temporary).catch(error => {
				if (!isEnoent(error)) throw error;
			});
		}
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
		return this.#lane(key, async () => {
			signal?.throwIfAborted();
			let dir: string;
			try {
				dir = await this.#directory(key, offset === 0);
			} catch (error) {
				if (isEnoent(error))
					throw new EngineTargetError("stale_target", "Attachment upload must start at offset zero");
				throw error;
			}
			await this.#assertPresent(dir);
			let manifest: UploadManifest;
			try {
				manifest = await this.#manifest(dir);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				if (offset !== 0)
					throw new EngineTargetError("stale_target", "Attachment upload must start at offset zero");
				manifest = { version: 1, ownerHash, attachment, state: "pending" };
				await this.#save(dir, manifest);
			}
			if (manifest.ownerHash !== ownerHash || JSON.stringify(manifest.attachment) !== JSON.stringify(attachment))
				throw new EngineTargetError("stale_target", "Attachment identity changed or was removed");
			if (manifest.state === "ready") {
				const range = await this.blobs.getRange(attachment.contentHash.slice(7), offset, Math.max(1, chunk.length));
				if (!range || range.totalBytes !== attachment.bytes || !range.data.equals(chunk))
					throw new EngineTargetError("stale_target", "Attachment retry differs from the completed upload");
				await fs.promises.unlink(path.join(dir, "payload.bin")).catch(error => {
					if (!isEnoent(error)) throw error;
				});
				return { attachment, nextOffset: attachment.bytes, complete: true };
			}
			const payload = path.join(dir, "payload.bin");
			const handle = await this.#file(payload, true);
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
					await handle.sync();
					currentBytes = offset + chunk.length;
				}
			} finally {
				await handle.close();
			}
			if (currentBytes === attachment.bytes) {
				await this.blobs.importFile(
					payload,
					{ hash: attachment.contentHash.slice(7), bytes: attachment.bytes },
					signal,
				);
				await this.#save(dir, { ...manifest, state: "ready" });
				await fs.promises.unlink(payload);
			}
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
			try {
				const dir = await this.#directory(key, false);
				await this.#assertPresent(dir);
				const manifest = await this.#manifest(dir);
				if (
					manifest.ownerHash !== ownerHash ||
					manifest.attachment.uploadId !== uploadId ||
					manifest.attachment.clientMessageId !== clientMessageId ||
					manifest.state !== "ready"
				)
					throw new EngineTargetError("stale_target", "Attachment is not ready for this message");
				const range = await this.blobs.getRange(manifest.attachment.contentHash.slice(7), 0, 1);
				if (!range || range.totalBytes !== manifest.attachment.bytes)
					throw new EngineTargetError("source_unavailable", "Attachment bytes are no longer retained");
				return manifest.attachment;
			} catch (error) {
				if (isEnoent(error))
					throw new EngineTargetError("stale_target", "Attachment is not available to this owner");
				throw error;
			}
		});
	}

	/** Image delivery only; unsupported file types stay explicit until file-tool delivery is wired. */
	async prepareForMessage(
		clientMessageId: string,
		references: EngineMessageAttachments,
		signal?: AbortSignal,
	): Promise<{ images: ImageContent[]; originalAttachments: SessionOriginalAttachment[] }> {
		const attachments = await this.resolveMessage(clientMessageId, references, signal);
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
			const data = Buffer.alloc(attachment.bytes);
			const hash = new Bun.SHA256();
			let offset = 0;
			while (offset < data.length) {
				signal?.throwIfAborted();
				const range = await this.blobs.getRange(
					attachment.contentHash.slice(7),
					offset,
					Math.min(BLOB_RANGE_BYTES, data.length - offset),
				);
				if (!range || range.totalBytes !== data.length || !range.data.length)
					throw new EngineTargetError("source_unavailable", "Attachment bytes changed or are no longer retained");
				range.data.copy(data, offset);
				hash.update(range.data);
				offset += range.data.length;
			}
			if (`sha256:${hash.digest("hex")}` !== attachment.contentHash)
				throw new EngineTargetError(
					"source_unavailable",
					"Attachment SHA-256 no longer matches its uploaded bytes",
				);
			if (parseImageMetadata(data)?.mimeType !== attachment.mediaType)
				throw new EngineTargetError("invalid_request", "Attachment bytes do not match the declared image type");
			images.push({ type: "image", mimeType: attachment.mediaType, data: data.toString("base64") });
		}
		signal?.throwIfAborted();
		return { images, originalAttachments };
	}

	async remove(principalId: string, uploadId: string): Promise<{ removed: true }> {
		const { key, ownerHash } = this.#key(principalId, uploadId);
		return this.#lane(key, async () => {
			const dir = await this.#directory(key, true);
			try {
				const marker = await fs.promises.open(path.join(dir, "removed"), "wx");
				try {
					await marker.writeFile(ownerHash);
					await marker.sync();
				} finally {
					await marker.close();
				}
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
			}
			await fs.promises.unlink(path.join(dir, "payload.bin")).catch(error => {
				if (!isEnoent(error)) throw error;
			});
			// Canonical blobs may already be shared with retained history. Never delete them here.
			return { removed: true };
		});
	}
}
