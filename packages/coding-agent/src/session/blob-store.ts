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
	/** Current physical content-addressed path. */
	path: string;
	/** Path with the requested extension when supplied, otherwise the canonical path. */
	displayPath: string;
	get ref(): string;
}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * New files are stored at `<dir>/.managed/live/<sha256-hex>`; old flat files
 * remain readable while the storage owner migrates them. Callers may request
 * a typed sidecar path for `file://` links and OS
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

const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);
const LOCK_PAUSE = new Int32Array(new SharedArrayBuffer(4));
const LOCK_ATTEMPTS = 500;
const LOCK_RETRY_MS = 10;

interface BlobIntent {
	id: string;
	hash: string;
	extension?: string;
	temporary: string;
	done: string;
}

function isExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function syncDirectory(directory: string): void {
	if (process.platform === "win32") return;
	const fd = fs.openSync(directory, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

async function syncDirectoryAsync(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fsp.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function writeExclusiveAndSync(file: string, contents: Buffer | string): void {
	const fd = fs.openSync(file, "wx");
	try {
		fs.writeFileSync(fd, contents);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

async function writeExclusiveAndSyncAsync(file: string, contents: Buffer | string): Promise<void> {
	const handle = await fsp.open(file, "wx");
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function unlinkIfPresent(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function unlinkIfPresentAsync(file: string): Promise<void> {
	await fsp.unlink(file).catch(error => {
		if (!isEnoent(error)) throw error;
	});
}

function sameFileBytesSync(file: string, data: Buffer): boolean {
	const before = fs.lstatSync(file);
	if (!before.isFile() || before.isSymbolicLink() || before.size !== data.length) return false;
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return false;
		const chunk = Buffer.alloc(Math.min(BLOB_RANGE_BYTES, data.length));
		for (let offset = 0; offset < data.length; ) {
			const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, data.length - offset), offset);
			if (!read || !chunk.subarray(0, read).equals(data.subarray(offset, offset + read))) return false;
			offset += read;
		}
		const after = fs.fstatSync(fd);
		return after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs;
	} finally {
		fs.closeSync(fd);
	}
}

async function sameFileBytesAsync(
	file: string,
	data: Buffer,
	signal?: AbortSignal,
	afterFirstChunk?: () => void | Promise<void>,
): Promise<boolean> {
	const before = await fsp.lstat(file);
	if (!before.isFile() || before.isSymbolicLink() || before.size !== data.length) return false;
	const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return false;
		const chunk = Buffer.alloc(Math.min(BLOB_RANGE_BYTES, data.length));
		for (let offset = 0; offset < data.length; ) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, data.length - offset), offset);
			if (!bytesRead || !chunk.subarray(0, bytesRead).equals(data.subarray(offset, offset + bytesRead)))
				return false;
			if (offset === 0) await afterFirstChunk?.();
			offset += bytesRead;
		}
		const after = await handle.stat();
		return after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs;
	} finally {
		await handle.close();
	}
}

function linkOrVerifySync(source: string, destination: string, data: Buffer): void {
	try {
		fs.linkSync(source, destination);
	} catch (error) {
		if (!isExists(error) || !sameFileBytesSync(destination, data))
			throw new Error(`Existing blob conflicts with publication: ${destination}`, { cause: error });
	}
}

async function linkOrVerifyAsync(
	source: string,
	destination: string,
	data: Buffer,
	signal?: AbortSignal,
	afterFirstChunk?: () => void | Promise<void>,
): Promise<void> {
	try {
		await fsp.link(source, destination);
	} catch (error) {
		if (!isExists(error) || !(await sameFileBytesAsync(destination, data, signal, afterFirstChunk)))
			throw new Error(`Existing blob conflicts with publication: ${destination}`, { cause: error });
	}
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
	readonly #checkpoint?: (
		stage: "intent" | "publication_lock" | "canonical" | "complete" | "compare" | "lock_wait",
		hash: string,
	) => void | Promise<void>;
	/** Fault-injection seam for isolated publication crash tests. */
	constructor(
		readonly dir: string,
		checkpoint?: (
			stage: "intent" | "publication_lock" | "canonical" | "complete" | "compare" | "lock_wait",
			hash: string,
		) => void | Promise<void>,
	) {
		this.#checkpoint = checkpoint;
	}
	#assertSafeRoot(): void {
		try {
			const stat = fs.lstatSync(this.dir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Blob directory is unsafe");
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	async #assertSafeRootAsync(): Promise<void> {
		try {
			const stat = await fsp.lstat(this.dir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Blob directory is unsafe");
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	get liveDir(): string {
		return path.join(this.dir, ".managed", "live");
	}
	get legacyDir(): string {
		return path.join(this.dir, ".managed", "legacy");
	}
	get stagingDir(): string {
		return path.join(this.dir, ".managed", "staging");
	}
	get intentsDir(): string {
		return path.join(this.dir, ".managed", "intents");
	}
	get completedDir(): string {
		return path.join(this.dir, ".managed", "completed");
	}
	get locksDir(): string {
		return path.join(this.dir, ".managed", "locks");
	}
	#withPublicationLock<T>(hash: string, work: () => T, publishing = false): T {
		fs.mkdirSync(this.locksDir, { recursive: true });
		const directory = fs.lstatSync(this.locksDir);
		if (!directory.isDirectory() || directory.isSymbolicLink())
			throw new Error("Blob publication lock directory is unsafe");
		const lock = path.join(this.locksDir, `${hash}.lock`);
		let acquired = false;
		for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
			try {
				writeExclusiveAndSync(lock, `${process.pid}\n${PROCESS_STARTED_AT_MS}\n`);
				acquired = true;
				break;
			} catch (error) {
				if (!isExists(error)) throw error;
				let before: string;
				try {
					before = fs.readFileSync(lock, "utf8");
				} catch (readError) {
					if (isEnoent(readError)) continue;
					throw readError;
				}
				const pid = Number(before.split("\n", 1)[0]);
				let live = true;
				if (Number.isSafeInteger(pid) && pid > 0) {
					try {
						process.kill(pid, 0);
					} catch (probe) {
						live = !probe || typeof probe !== "object" || !("code" in probe) || probe.code !== "ESRCH";
					}
				}
				if (!live) {
					try {
						if (fs.readFileSync(lock, "utf8") === before) unlinkIfPresent(lock);
					} catch (readError) {
						if (!isEnoent(readError)) throw readError;
					}
					continue;
				}
				Atomics.wait(LOCK_PAUSE, 0, 0, LOCK_RETRY_MS);
			}
		}
		if (!acquired) throw new Error("Blob publication lock is busy");
		try {
			if (publishing) this.#checkpoint?.("publication_lock", hash);
			return work();
		} finally {
			unlinkIfPresent(lock);
		}
	}
	async #withPublicationLockAsync<T>(
		hash: string,
		work: () => Promise<T>,
		publishing = false,
		signal?: AbortSignal,
	): Promise<T> {
		await fsp.mkdir(this.locksDir, { recursive: true });
		const directory = await fsp.lstat(this.locksDir);
		if (!directory.isDirectory() || directory.isSymbolicLink())
			throw new Error("Blob publication lock directory is unsafe");
		const lock = path.join(this.locksDir, `${hash}.lock`);
		let acquired = false;
		const deadline = performance.now() + LOCK_ATTEMPTS * LOCK_RETRY_MS;
		for (let attempt = 0; attempt < LOCK_ATTEMPTS && performance.now() < deadline; attempt++) {
			signal?.throwIfAborted();
			try {
				await writeExclusiveAndSyncAsync(lock, `${process.pid}\n${PROCESS_STARTED_AT_MS}\n`);
				acquired = true;
				break;
			} catch (error) {
				if (!isExists(error)) throw error;
				let before: string;
				try {
					before = await fsp.readFile(lock, "utf8");
				} catch (readError) {
					if (isEnoent(readError)) continue;
					throw readError;
				}
				const pid = Number(before.split("\n", 1)[0]);
				let live = true;
				if (Number.isSafeInteger(pid) && pid > 0) {
					try {
						process.kill(pid, 0);
					} catch (probe) {
						live = !probe || typeof probe !== "object" || !("code" in probe) || probe.code !== "ESRCH";
					}
				}
				if (!live) {
					try {
						if ((await fsp.readFile(lock, "utf8")) === before) await unlinkIfPresentAsync(lock);
					} catch (readError) {
						if (!isEnoent(readError)) throw readError;
					}
					continue;
				}
				await this.#checkpoint?.("lock_wait", hash);
				await Bun.sleep(LOCK_RETRY_MS);
			}
		}
		if (!acquired) throw new Error("Blob publication lock is busy");
		try {
			signal?.throwIfAborted();
			if (publishing) await this.#checkpoint?.("publication_lock", hash);
			return await work();
		} finally {
			await unlinkIfPresentAsync(lock);
		}
	}
	#beginIntent(hash: string, extension?: string): BlobIntent {
		if (!BLOB_HASH_RE.test(hash)) throw new Error("Invalid blob hash");
		this.#assertSafeRoot();
		const id = crypto.randomUUID();
		const hashDir = path.join(this.intentsDir, hash);
		const name = `${process.pid}.${PROCESS_STARTED_AT_MS}.${id}${extension ? `.${extension}` : ""}`;
		this.#withPublicationLock(hash, () => {
			for (const directory of [this.liveDir, this.stagingDir, this.completedDir, hashDir]) {
				fs.mkdirSync(directory, { recursive: true });
				const stat = fs.lstatSync(directory);
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Blob publication directory is unsafe");
			}
			writeExclusiveAndSync(path.join(hashDir, name), "");
			syncDirectory(hashDir);
		});
		this.#checkpoint?.("intent", hash);
		return {
			id,
			hash,
			extension,
			temporary: path.join(this.stagingDir, `${id}.blob-tmp`),
			done: path.join(this.completedDir, `${id}.done`),
		};
	}
	async #beginIntentAsync(hash: string, extension?: string, signal?: AbortSignal): Promise<BlobIntent> {
		if (!BLOB_HASH_RE.test(hash)) throw new Error("Invalid blob hash");
		await this.#assertSafeRootAsync();
		const id = crypto.randomUUID();
		const hashDir = path.join(this.intentsDir, hash);
		const name = `${process.pid}.${PROCESS_STARTED_AT_MS}.${id}${extension ? `.${extension}` : ""}`;
		await this.#withPublicationLockAsync(
			hash,
			async () => {
				for (const directory of [this.liveDir, this.stagingDir, this.completedDir, hashDir]) {
					await fsp.mkdir(directory, { recursive: true });
					const stat = await fsp.lstat(directory);
					if (!stat.isDirectory() || stat.isSymbolicLink())
						throw new Error("Blob publication directory is unsafe");
				}
				await writeExclusiveAndSyncAsync(path.join(hashDir, name), "");
				await syncDirectoryAsync(hashDir);
			},
			false,
			signal,
		);
		await this.#checkpoint?.("intent", hash);
		return {
			id,
			hash,
			extension,
			temporary: path.join(this.stagingDir, `${id}.blob-tmp`),
			done: path.join(this.completedDir, `${id}.done`),
		};
	}
	#completeIntent(intent: BlobIntent): void {
		writeExclusiveAndSync(intent.done, "");
		syncDirectory(this.completedDir);
		this.#checkpoint?.("complete", intent.hash);
	}
	async #completeIntentAsync(intent: BlobIntent): Promise<void> {
		await writeExclusiveAndSyncAsync(intent.done, "");
		await syncDirectoryAsync(this.completedDir);
		await this.#checkpoint?.("complete", intent.hash);
	}
	#paths(name: string): string[] {
		return [path.join(this.liveDir, name), path.join(this.dir, name), path.join(this.legacyDir, name)];
	}

	/** Resolve an existing immutable body across the current and legacy layout. */
	async existingPath(hash: string): Promise<string | null> {
		if (!BLOB_HASH_RE.test(hash)) throw new Error("Invalid blob hash");
		this.#assertSafeRoot();
		for (const candidate of this.#paths(hash)) {
			try {
				const parent = await fsp.lstat(path.dirname(candidate));
				const body = await fsp.lstat(candidate);
				if (!parent.isDirectory() || parent.isSymbolicLink() || !body.isFile() || body.isSymbolicLink())
					throw new Error("Blob path is unsafe");
				return candidate;
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
		}
		return null;
	}

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
		const source = await fsp.open(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		let intent: BlobIntent;
		try {
			intent = await this.#beginIntentAsync(expected.hash, undefined, signal);
		} catch (error) {
			await source.close();
			throw error;
		}
		const destination = path.join(this.liveDir, expected.hash);
		const temporary = intent.temporary;
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
			let existing = false;
			await this.#withPublicationLockAsync(
				expected.hash,
				async () => {
					try {
						await fsp.link(temporary, destination);
					} catch (error) {
						if (!isExists(error)) throw error;
						existing = true;
					}
					await syncDirectoryAsync(this.liveDir);
				},
				true,
				signal,
			);
			signal?.throwIfAborted();
			await this.#checkpoint?.("canonical", expected.hash);
			if (existing) {
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
				await this.#completeIntentAsync(intent);
				if (ownsTemporary)
					await fsp.unlink(temporary).catch(error => {
						if (!isEnoent(error)) throw error;
					});
			}
		}
	}

	async restore(hash: string, data: Buffer, extension?: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (!BLOB_HASH_RE.test(hash) || new Bun.SHA256().update(data).digest("hex") !== hash)
			throw new Error("Archived blob hash does not match");
		const normalizedExtension = normalizeBlobExtension(extension);
		const intent = await this.#beginIntentAsync(hash, normalizedExtension, signal);
		const destination = path.join(this.liveDir, hash);
		const temporary = intent.temporary;
		try {
			signal?.throwIfAborted();
			const handle = await fsp.open(temporary, "wx");
			try {
				await handle.writeFile(data);
				await handle.sync();
			} finally {
				await handle.close();
			}
			signal?.throwIfAborted();
			await this.#withPublicationLockAsync(
				hash,
				async () => {
					if (normalizedExtension)
						await linkOrVerifyAsync(temporary, `${destination}.${normalizedExtension}`, data, signal, () =>
							this.#checkpoint?.("compare", hash),
						);
					await linkOrVerifyAsync(temporary, destination, data, signal, () => this.#checkpoint?.("compare", hash));
					await syncDirectoryAsync(this.liveDir);
				},
				true,
				signal,
			);
			signal?.throwIfAborted();
			await this.#checkpoint?.("canonical", hash);
		} finally {
			await this.#completeIntentAsync(intent);
			await fsp.unlink(temporary).catch(error => {
				if (!isEnoent(error)) throw error;
			});
		}
	}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer, options?: BlobPutOptions, signal?: AbortSignal): Promise<BlobPutResult> {
		signal?.throwIfAborted();
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.liveDir, hash);
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

		await this.restore(hash, data, extension, signal);
		return result;
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.liveDir, hash);
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
		const intent = this.#beginIntent(hash, extension);
		try {
			writeExclusiveAndSync(intent.temporary, data);
			this.#withPublicationLock(
				hash,
				() => {
					if (extension) linkOrVerifySync(intent.temporary, displayPath, data);
					linkOrVerifySync(intent.temporary, blobPath, data);
					syncDirectory(this.liveDir);
				},
				true,
			);
			this.#checkpoint?.("canonical", hash);
		} finally {
			this.#completeIntent(intent);
			unlinkIfPresent(intent.temporary);
		}
		return result;
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	async get(hash: string): Promise<Buffer | null> {
		this.#assertSafeRoot();
		for (const blobPath of this.#paths(hash)) {
			try {
				const file = Bun.file(blobPath);
				const ab = await file.arrayBuffer();
				return Buffer.from(ab);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
		}
		return null;
	}

	/** Synchronous variant of {@link get}. */
	getSync(hash: string): Buffer | null {
		this.#assertSafeRoot();
		for (const blobPath of this.#paths(hash)) {
			try {
				return fs.readFileSync(blobPath);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
		}
		return null;
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
		this.#assertSafeRoot();
		for (const blobPath of this.#paths(hash)) {
			try {
				const directory = await fsp.lstat(path.dirname(blobPath));
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
				if (isEnoent(error)) continue;
				throw error;
			}
		}
		return null;
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
		this.#assertSafeRoot();
		for (const blobPath of this.#paths(hash)) {
			try {
				await fsp.access(blobPath);
				return true;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		return false;
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
