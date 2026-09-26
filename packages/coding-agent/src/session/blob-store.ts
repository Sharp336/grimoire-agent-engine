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

/** A completed upload file to publish without copying: its declared identity is verified before linking. */
export interface BlobFileSource {
	file: string;
	hash: string;
	bytes: number;
}

/**
 * One managed body in `.managed/live`, pinned by this producer's intent until the owner record decides.
 * Both methods are idempotent, settle the pin exactly once and never throw: a pin that cannot be
 * removed stays until this process exits, when the storage owner treats it as a dead producer.
 */
export interface BlobPublication {
	readonly hash: string;
	/** `.managed/live/<hash>`. */
	readonly path: string;
	/** Typed sidecar hardlink for image openers, otherwise {@link path}. */
	readonly displayPath: string;
	/** The owner record naming this body is applied: drop the pin. */
	release(): Promise<void>;
	/** The owner record will not be written, or its outcome is unknown: let the storage owner decide. */
	abandon(): Promise<void>;
}

/** A published file does not have the size or SHA-256 its caller declared (for example a torn upload). */
export class BlobSourceMismatchError extends Error {}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Interactive sessions keep the upstream flat layout, `<dir>/<sha256-hex>` plus an optional typed
 * sidecar `<dir>/<sha256-hex>.<ext>` for `file://` links and OS image viewers ({@link BlobStore.put}).
 * A storage contour root is owned by its Rust storage worker: the Engine writes there only through
 * {@link BlobStore.publish}, which follows the managed C2/C3 protocol (`.managed/intents`, `staging`,
 * `locks`, `live`). Reads look in `.managed/live` first, then in the flat root.
 * The SHA-256 hash is computed over the raw binary data (not base64).
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
		if (isExists(err)) return;
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
		if (isExists(err)) return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	fs.writeFileSync(displayPath, data);
}

const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);
/** Lock and breaker content shared with the Rust owner: `<pid>\n<startMs>\n`. */
const OWNER_STAMP = `${process.pid}\n${PROCESS_STARTED_AT_MS}\n`;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 10;

function isExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fsp.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeExclusiveAndSync(file: string, contents: Buffer | string): Promise<void> {
	const handle = await fsp.open(file, "wx");
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function createExclusive(file: string, contents: string): Promise<boolean> {
	try {
		await writeExclusiveAndSync(file, contents);
		return true;
	} catch (error) {
		if (isExists(error)) return false;
		throw error;
	}
}

async function unlinkIfPresent(file: string): Promise<void> {
	await fsp.unlink(file).catch(error => {
		if (!isEnoent(error)) throw error;
	});
}

function processIsLive(pid: number, startedAtMs: number): boolean {
	// The start time of another process is not visible here; only our own identity is exact.
	if (pid === process.pid) return startedAtMs === PROCESS_STARTED_AT_MS;
	try {
		process.kill(pid, 0);
		return true;
	} catch (probe) {
		return !probe || typeof probe !== "object" || !("code" in probe) || probe.code !== "ESRCH";
	}
}

/** Remove a lock or breaker whose owner process is gone, unless it changed while we looked. */
async function removeStale(file: string): Promise<boolean> {
	let content: string;
	try {
		content = await fsp.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	const [pid, startedAtMs] = content.split("\n", 2).map(Number);
	if (!Number.isSafeInteger(pid) || pid <= 0 || processIsLive(pid, startedAtMs)) return false;
	try {
		if ((await fsp.readFile(file, "utf8")) !== content) return false;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	await unlinkIfPresent(file);
	return true;
}

/** Existing regular body with exactly the expected size; a different size is a conflict, never replaced. */
async function hasBody(file: string, bytes: number): Promise<boolean> {
	let stat: fs.Stats;
	try {
		stat = await fsp.lstat(file);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes)
		throw new Error(`Existing blob conflicts with publication: ${file}`);
	return true;
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
	readonly #checkpoint?: (stage: "intent" | "publication_lock" | "canonical" | "lock_wait", hash: string) => void;
	/** `checkpoint` is a fault-injection seam for isolated publication crash tests. */
	constructor(
		readonly dir: string,
		checkpoint?: (stage: "intent" | "publication_lock" | "canonical" | "lock_wait", hash: string) => void,
	) {
		this.#checkpoint = checkpoint;
	}
	get liveDir(): string {
		return path.join(this.dir, ".managed", "live");
	}
	get stagingDir(): string {
		return path.join(this.dir, ".managed", "staging");
	}
	get intentsDir(): string {
		return path.join(this.dir, ".managed", "intents");
	}
	get locksDir(): string {
		return path.join(this.dir, ".managed", "locks");
	}

	async #safeDirectory(directory: string, create: boolean): Promise<void> {
		if (create) await fsp.mkdir(directory, { recursive: true });
		const stat = await fsp.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Blob directory is unsafe: ${directory}`);
	}

	/** Hold `.managed/locks/<hash>.lock`; a dead holder's lock is broken only through its `.break` gate (C3). */
	async #withLock<T>(hash: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const lock = path.join(this.locksDir, `${hash}.lock`);
		const deadline = performance.now() + LOCK_WAIT_MS;
		for (;;) {
			signal?.throwIfAborted();
			if (await createExclusive(lock, OWNER_STAMP)) break;
			if (await this.#breakStaleLock(lock)) continue;
			if (performance.now() >= deadline) throw new Error("Blob publication lock is busy");
			this.#checkpoint?.("lock_wait", hash);
			await Bun.sleep(LOCK_RETRY_MS);
		}
		try {
			return await work();
		} finally {
			await unlinkIfPresent(lock);
		}
	}

	async #breakStaleLock(lock: string): Promise<boolean> {
		const gate = `${lock}.break`;
		if (
			!(await createExclusive(gate, OWNER_STAMP)) &&
			!((await removeStale(gate)) && (await createExclusive(gate, OWNER_STAMP)))
		)
			return false;
		try {
			return await removeStale(lock);
		} finally {
			await unlinkIfPresent(gate);
		}
	}

	/** Pin `hash` before any body work: `.managed/intents/<hash>/<pid>.<startMs>.<uuid>`. */
	async #createIntent(hash: string, id: string): Promise<string> {
		const directory = path.join(this.intentsDir, hash);
		const intent = path.join(directory, `${process.pid}.${PROCESS_STARTED_AT_MS}.${id}`);
		for (let attempt = 0; ; attempt++) {
			await this.#safeDirectory(directory, true);
			try {
				await writeExclusiveAndSync(intent, "");
				break;
			} catch (error) {
				// The owner removes an empty hash directory under its lock; recreate it once more.
				if (!isEnoent(error) || attempt >= 2) throw error;
			}
		}
		await syncDirectory(directory);
		return intent;
	}

	/**
	 * Publish one managed body under C3: intent → staging (skipped when the body is already live) →
	 * under the per-hash lock reuse by size or link staging into `.managed/live` → drop staging.
	 * The returned intent pin holds until the caller releases it after the owner record is applied,
	 * or abandons it. A file source is linked, not copied (copied only across volumes), and its
	 * declared size and SHA-256 are verified in one streaming pass first.
	 */
	async publish(
		source: Buffer | BlobFileSource,
		options?: { extension?: string; signal?: AbortSignal },
	): Promise<BlobPublication> {
		const signal = options?.signal;
		signal?.throwIfAborted();
		const data = Buffer.isBuffer(source) ? source : undefined;
		const hash = data ? new Bun.SHA256().update(data).digest("hex") : (source as BlobFileSource).hash;
		const bytes = data ? data.length : (source as BlobFileSource).bytes;
		if (!BLOB_HASH_RE.test(hash) || !Number.isSafeInteger(bytes) || bytes < 0)
			throw new Error("Invalid blob publication identity");
		const extension = normalizeBlobExtension(options?.extension);
		// Managed sidecars are limited to the fixed image set the storage owner deletes with the body (C2).
		const sidecar = extension && Object.values(IMAGE_EXTENSION_BY_MIME).includes(extension) ? extension : undefined;
		await this.#safeDirectory(this.dir, true);
		for (const directory of [this.liveDir, this.stagingDir, this.intentsDir, this.locksDir])
			await this.#safeDirectory(directory, true);
		const id = crypto.randomUUID();
		const intent = await this.#createIntent(hash, id);
		this.#checkpoint?.("intent", hash);
		const staging = path.join(this.stagingDir, `${id}.tmp`);
		const destination = path.join(this.liveDir, hash);
		const displayPath = sidecar ? `${destination}.${sidecar}` : destination;
		let settled = false;
		const settle = async (action: "release" | "abandon"): Promise<void> => {
			if (settled) return;
			settled = true;
			try {
				if (action === "release") await unlinkIfPresent(intent);
				else {
					await unlinkIfPresent(staging);
					await fsp.rename(intent, `${intent}.abandoned`);
				}
			} catch (error) {
				if (isEnoent(error)) return;
				logger.warn("Blob publication pin was not settled; it expires with this process", {
					hash,
					action,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		try {
			let staged = false;
			const stage = async () => {
				if (data) await writeExclusiveAndSync(staging, data);
				else await this.#stageFile(source as BlobFileSource, staging, signal);
				staged = true;
			};
			if (!data || !(await hasBody(destination, bytes))) await stage();
			signal?.throwIfAborted();
			await this.#withLock(
				hash,
				async () => {
					this.#checkpoint?.("publication_lock", hash);
					if (!(await hasBody(destination, bytes))) {
						// The owner reclaimed the body between the pre-check and this lock.
						if (!staged) await stage();
						await fsp.link(staging, destination);
					}
					if (sidecar) await this.#linkSidecar(destination, displayPath);
					await syncDirectory(this.liveDir);
				},
				signal,
			);
			this.#checkpoint?.("canonical", hash);
			if (staged) await unlinkIfPresent(staging);
		} catch (error) {
			await settle("abandon");
			throw error;
		}
		return {
			hash,
			path: destination,
			displayPath,
			release: () => settle("release"),
			abandon: () => settle("abandon"),
		};
	}

	/**
	 * Link (or, across volumes, copy) a completed file into staging, verify it in one streaming pass and
	 * make its bytes durable once; the producer writes its chunks without per-chunk fsync.
	 */
	async #stageFile(source: BlobFileSource, staging: string, signal?: AbortSignal): Promise<void> {
		const before = await fsp.lstat(source.file);
		if (!before.isFile() || before.isSymbolicLink()) throw new Error("Blob publication source is unsafe");
		try {
			await fsp.link(source.file, staging);
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") throw error;
			await fsp.copyFile(source.file, staging, fs.constants.COPYFILE_EXCL);
		}
		// Read-write: Windows flushes file buffers only through a writable handle.
		const handle = await fsp.open(staging, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const digest = new Bun.SHA256();
			let total = 0;
			const buffer = Buffer.allocUnsafe(BLOB_RANGE_BYTES);
			for (;;) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
				if (!bytesRead) break;
				digest.update(buffer.subarray(0, bytesRead));
				total += bytesRead;
				if (total > source.bytes) break;
			}
			if (total !== source.bytes || digest.digest("hex") !== source.hash)
				throw new BlobSourceMismatchError("Published file does not match its declared size and SHA-256 hash");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async #linkSidecar(destination: string, sidecar: string): Promise<void> {
		try {
			await fsp.link(destination, sidecar);
		} catch (error) {
			if (!isExists(error)) throw error;
			const [body, existing] = await Promise.all([fsp.lstat(destination), fsp.lstat(sidecar)]);
			if (existing.isSymbolicLink() || existing.dev !== body.dev || existing.ino !== body.ino)
				throw new Error(`Existing blob sidecar conflicts with publication: ${sidecar}`, { cause: error });
		}
	}

	#paths(hash: string): string[] {
		return [path.join(this.liveDir, hash), path.join(this.dir, hash)];
	}

	/** Read-path candidates for a validated hash, refusing a linked or non-directory root instead of following it. */
	async #candidates(hash: string): Promise<string[]> {
		if (!BLOB_HASH_RE.test(hash)) throw new Error("Invalid blob hash");
		try {
			const root = await fsp.lstat(this.dir);
			if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Blob directory is unsafe");
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return this.#paths(hash);
	}

	/** Open the first present body through one descriptor, refusing links and swapped files. */
	async #open(hash: string): Promise<{ handle: fsp.FileHandle; size: number } | null> {
		for (const blobPath of await this.#candidates(hash)) {
			let before: fs.Stats;
			try {
				before = await fsp.lstat(blobPath);
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			if (!before.isFile() || before.isSymbolicLink()) throw new Error("Blob path is unsafe");
			const handle = await fsp.open(blobPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			try {
				const opened = await handle.stat();
				if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
					throw new Error("Blob identity changed");
				return { handle, size: opened.size };
			} catch (error) {
				await handle.close();
				throw error;
			}
		}
		return null;
	}

	/** Resolve an existing immutable body in `.managed/live`, then in the flat root. */
	async existingPath(hash: string): Promise<string | null> {
		for (const candidate of await this.#candidates(hash)) {
			try {
				const body = await fsp.lstat(candidate);
				if (!body.isFile() || body.isSymbolicLink()) throw new Error("Blob path is unsafe");
				return candidate;
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
		}
		return null;
	}

	/**
	 * Write binary data to the flat interactive store (upstream layout, no managed protocol).
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
		const opened = await this.#open(hash);
		if (!opened) return null;
		const { handle, size } = opened;
		try {
			if (offset > size) throw new Error("Blob range starts after EOF");
			const data = Buffer.alloc(Math.min(limit, size - offset));
			let read = 0;
			while (read < data.length) {
				const { bytesRead } = await handle.read(data, read, data.length - read, offset + read);
				if (!bytesRead) throw new Error("Blob changed during read");
				read += bytesRead;
			}
			const end = offset + data.length;
			return { data, totalBytes: size, nextOffset: end < size ? end : null };
		} finally {
			await handle.close();
		}
	}

	/**
	 * Stream a whole body through one descriptor into `sink`, verifying its exact size and SHA-256.
	 * `sink` must consume each chunk before it resolves: the buffer is reused. Returns false when absent;
	 * throws when the body has another size or digest (the sink may already have seen its bytes).
	 */
	async readVerified(
		hash: string,
		bytes: number,
		sink: (chunk: Buffer) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<boolean> {
		const opened = await this.#open(hash);
		if (!opened) return false;
		const { handle, size } = opened;
		try {
			if (size !== bytes) throw new Error(`Blob ${hash} size or SHA-256 does not match its identity`);
			const digest = new Bun.SHA256();
			const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(BLOB_RANGE_BYTES, bytes)));
			for (let offset = 0; offset < bytes; ) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
				if (!bytesRead) throw new Error(`Blob ${hash} changed during read`);
				const chunk = buffer.subarray(0, bytesRead);
				digest.update(chunk);
				await sink(chunk);
				offset += bytesRead;
			}
			if (digest.digest("hex") !== hash) throw new Error(`Blob ${hash} size or SHA-256 does not match its identity`);
			return true;
		} finally {
			await handle.close();
		}
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
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
