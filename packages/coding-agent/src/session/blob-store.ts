import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

const BLOB_PREFIX = "blob:sha256:";

/** Canonical blob hash shape: exactly 64 lowercase hex chars (a SHA-256 digest). */
export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

export const BLOB_RANGE_BYTES = 65_536;

export interface BlobRange {
	data: Buffer;
	totalBytes: number;
	nextOffset: number | null;
}

export interface BlobPutOptions {
	/** Optional file extension for a sidecar hardlink/copy that OS openers can type-detect. */
	extension?: string;
}

export interface BlobPutResult {
	hash: string;
	/** Canonical content-addressed path, always `<dir>/<sha256-hex>`. */
	path: string;
	/** Path with the requested extension when supplied, otherwise the canonical path. */
	displayPath: string;
	get ref(): string;
}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Files are stored canonically at `<dir>/<sha256-hex>`. Callers may also request
 * a typed sidecar path (`<dir>/<sha256-hex>.<ext>`) for `file://` links and OS
 * image viewers; blob refs and reads still address the extensionless hash path.
 * The SHA-256 hash is computed over the raw binary data (not base64).
 * Content-addressing makes writes idempotent and provides automatic deduplication
 * across sessions.
 */

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

function normalizeBlobExtension(extension: string | undefined): string | undefined {
	if (!extension) return undefined;
	const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
	if (normalized.length === 0 || normalized.length > 32) return undefined;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) return undefined;
	return normalized.toLowerCase();
}

async function ensureDisplayPath(blobPath: string, displayPath: string, data: Buffer): Promise<void> {
	if (displayPath === blobPath) return;
	try {
		await fsp.link(blobPath, displayPath);
		return;
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	await Bun.write(displayPath, data);
}

function ensureDisplayPathSync(blobPath: string, displayPath: string, data: Buffer): void {
	if (displayPath === blobPath) return;
	try {
		fs.linkSync(blobPath, displayPath);
		return;
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	fs.writeFileSync(displayPath, data);
}

export function blobExtensionForImageMimeType(mimeType: string | undefined): string | undefined {
	if (!mimeType) return undefined;
	const lower = mimeType.toLowerCase();
	const known = IMAGE_EXTENSION_BY_MIME[lower];
	if (known) return known;
	if (!lower.startsWith("image/")) return undefined;
	const subtype = lower.slice("image/".length).split(";")[0]?.split("+")[0];
	return normalizeBlobExtension(subtype);
}

export class BlobStore {
	constructor(readonly dir: string) {}

	/** Import a completed upload without buffering it or exposing a partial canonical blob.
	 * The caller owns admission/ACL for sourcePath; a blob hash alone is not authorization.
	 */
	async importFile(
		sourcePath: string,
		expected: { hash: string; bytes: number },
		signal?: AbortSignal,
	): Promise<BlobPutResult> {
		if (!BLOB_HASH_RE.test(expected.hash) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0)
			throw new Error("Invalid upload blob identity");
		signal?.throwIfAborted();
		const sourceStat = await fsp.lstat(sourcePath);
		if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== expected.bytes)
			throw new Error("Upload source is unsafe or its size changed");
		await fsp.mkdir(this.dir, { recursive: true });
		const directory = await fsp.lstat(this.dir);
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Blob directory is unsafe");
		const destination = path.join(this.dir, expected.hash);
		const temporary = path.join(this.dir, `${expected.hash}.${crypto.randomUUID()}.upload-tmp`);
		const source = await fsp.open(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		let ownsTemporary = false;
		try {
			const opened = await source.stat();
			if (
				!opened.isFile() ||
				opened.dev !== sourceStat.dev ||
				opened.ino !== sourceStat.ino ||
				opened.size !== expected.bytes
			)
				throw new Error("Upload source changed before capture");
			const output = await fsp.open(temporary, "wx");
			ownsTemporary = true;
			try {
				const hash = new Bun.SHA256();
				const buffer = Buffer.alloc(BLOB_RANGE_BYTES);
				let offset = 0;
				while (offset < expected.bytes) {
					signal?.throwIfAborted();
					const { bytesRead } = await source.read(
						buffer,
						0,
						Math.min(buffer.length, expected.bytes - offset),
						offset,
					);
					if (!bytesRead) throw new Error("Upload source ended before its declared size");
					const chunk = buffer.subarray(0, bytesRead);
					hash.update(chunk);
					await output.writeFile(chunk);
					offset += bytesRead;
				}
				const after = await source.stat();
				if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
					throw new Error("Upload source changed during capture");
				if (hash.digest("hex") !== expected.hash) throw new Error("Upload blob hash does not match");
				await output.sync();
			} finally {
				await output.close();
			}
			signal?.throwIfAborted();
			try {
				// Same-directory hardlink publishes atomically and never overwrites another writer.
				await fsp.link(temporary, destination);
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
				const hash = new Bun.SHA256();
				let offset = 0;
				for (;;) {
					signal?.throwIfAborted();
					const range = await this.getRange(expected.hash, offset, BLOB_RANGE_BYTES);
					if (!range || range.totalBytes !== expected.bytes)
						throw new Error("Existing blob conflicts with upload");
					hash.update(range.data);
					if (range.nextOffset === null) break;
					offset = range.nextOffset;
				}
				if (hash.digest("hex") !== expected.hash) throw new Error("Existing blob conflicts with upload");
			}
			if (process.platform !== "win32") {
				const handle = await fsp.open(this.dir, "r");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
			}
			return {
				hash: expected.hash,
				path: destination,
				displayPath: destination,
				get ref() {
					return `${BLOB_PREFIX}${expected.hash}`;
				},
			};
		} finally {
			try {
				await source.close();
			} finally {
				if (ownsTemporary) await fsp.unlink(temporary);
			}
		}
	}

	async restore(hash: string, data: Buffer): Promise<void> {
		if (!BLOB_HASH_RE.test(hash) || new Bun.SHA256().update(data).digest("hex") !== hash)
			throw new Error("Archived blob hash does not match");
		await fsp.mkdir(this.dir, { recursive: true });
		if ((await fsp.lstat(this.dir)).isSymbolicLink()) throw new Error("Blob directory is unsafe");
		const destination = path.join(this.dir, hash);
		const temporary = path.join(this.dir, `${hash}.${crypto.randomUUID()}.restore-tmp`);
		const handle = await fsp.open(temporary, "wx");
		try {
			await handle.writeFile(data);
			await handle.sync();
			await handle.close();
			try {
				await fsp.link(temporary, destination);
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
				const stat = await fsp.lstat(destination);
				if (
					!stat.isFile() ||
					stat.isSymbolicLink() ||
					stat.size !== data.byteLength ||
					!(await fsp.readFile(destination)).equals(data)
				)
					throw new Error("Existing blob conflicts with archive");
			}
		} finally {
			await handle.close();
			await fsp.unlink(temporary);
		}
		if (process.platform !== "win32") {
			const directory = await fsp.open(this.dir, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};

		await Bun.write(blobPath, data);
		await ensureDisplayPath(blobPath, displayPath, data);
		return result;
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(blobPath, data);
		ensureDisplayPathSync(blobPath, displayPath, data);
		return result;
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	async get(hash: string): Promise<Buffer | null> {
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Synchronous variant of {@link get}. */
	getSync(hash: string): Buffer | null {
		const blobPath = path.join(this.dir, hash);
		try {
			return fs.readFileSync(blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Bounded binary read. Callers must authorize the owning session before exposing a blob. */
	async getRange(hash: string, offset: number, limit: number): Promise<BlobRange | null> {
		if (!BLOB_HASH_RE.test(hash)) throw new Error("Invalid blob hash");
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > BLOB_RANGE_BYTES
		)
			throw new Error("Invalid blob byte range");
		const blobPath = path.join(this.dir, hash);
		try {
			const directory = await fsp.lstat(this.dir);
			const before = await fsp.lstat(blobPath);
			if (!directory.isDirectory() || directory.isSymbolicLink() || !before.isFile() || before.isSymbolicLink())
				throw new Error("Blob path is unsafe");
			const handle = await fsp.open(blobPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			try {
				const opened = await handle.stat();
				if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
					throw new Error("Blob identity changed");
				if (!Number.isSafeInteger(opened.size) || offset > opened.size)
					throw new Error("Blob range starts after EOF");
				const data = Buffer.alloc(Math.min(limit, opened.size - offset));
				let read = 0;
				while (read < data.length) {
					const { bytesRead } = await handle.read(data, read, data.length - read, offset + read);
					if (!bytesRead) throw new Error("Blob changed during read");
					read += bytesRead;
				}
				const after = await handle.stat();
				if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
					throw new Error("Blob changed during read");
				const end = offset + data.length;
				return { data, totalBytes: opened.size, nextOffset: end < opened.size ? end : null };
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			return false;
		}
	}
}

/** Check if a data string is a blob reference. */
export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/**
 * Extract the SHA-256 hash from a blob reference string.
 *
 * Returns null when the string is not a blob ref, or when the suffix is not a
 * canonical 64-char lowercase hex hash. Rejecting non-hash suffixes here is the
 * single choke point that keeps every resolution path confined to the blob dir:
 * `get`/`getSync` feed this value into `path.join(this.dir, hash)`, so an
 * unvalidated `../` suffix would otherwise escape the store and read arbitrary files.
 */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	if (!BLOB_HASH_RE.test(hash)) {
		logger.warn("Rejected malformed blob reference", { suffix: hash });
		return null;
	}
	return hash;
}

/** Identify provider transport image data URLs so persistence can externalize and restore them losslessly. */
export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

/**
 * Externalize a provider image data URL to the blob store, returning a blob reference.
 * The full data URL string is preserved so transport-native history can be reconstructed on resume.
 */
export async function externalizeImageDataUrl(blobStore: BlobStore, dataUrl: string): Promise<string> {
	if (isBlobRef(dataUrl)) return dataUrl;
	const { ref } = await blobStore.put(Buffer.from(dataUrl, "utf8"));
	return ref;
}

/** Synchronous variant of {@link externalizeImageDataUrl}. */
export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.putSync(Buffer.from(dataUrl, "utf8")).ref;
}

/**
 * Externalize an image's base64 data to the blob store, returning a blob reference.
 * If the data is already a blob reference, returns it unchanged.
 */
export async function externalizeImageData(
	blobStore: BlobStore,
	base64Data: string,
	mimeType?: string,
): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer, {
		extension: blobExtensionForImageMimeType(mimeType),
	});
	return ref;
}

/** Synchronous variant of {@link externalizeImageData}. */
export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string, mimeType?: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	return blobStore.putSync(Buffer.from(base64Data, "base64"), {
		extension: blobExtensionForImageMimeType(mimeType),
	}).ref;
}

/**
 * Resolve an externalized provider image data URL back to its original string.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns the reference as-is.
 */
export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/**
 * Resolve a blob reference back to base64 data.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns a placeholder.
 */
export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data; // Return the ref as-is; downstream will see invalid base64 but won't crash
	}
	return buffer.toString("base64");
}

/** Synchronous variant of {@link resolveImageData}. */
export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}
