/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, stringProperty } from "@oh-my-pi/pi-utils";

export const MAX_ARTIFACT_RANGE_BYTES = 64 * 1024;
const ARTIFACT_MEDIA_TYPE = "text/plain; charset=utf-8";
const ARTIFACT_METADATA_VERSION = 1;
const ARTIFACT_ID_RE = /^\d+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface ArtifactAllocationContext {
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
}

export type ArtifactProvenanceSource = "tool_output" | "collaboration_media";

export interface ArtifactAllocationOptions {
	mediaType?: string;
	source?: ArtifactProvenanceSource;
}

export interface ArtifactDescriptor {
	id: string;
	mediaType: string;
	byteLength: number | null;
	sha256: string | null;
	provenance:
		| {
				source: "tool_output";
				toolName: string;
		  }
		| {
				source: "collaboration_media";
		  };
	related: ArtifactAllocationContext;
	lifecycle: "pending" | "available" | "cancelled";
	cancellation: {
		cancelled: boolean;
		reason?: string;
	};
}

export interface ArtifactRange {
	descriptor: ArtifactDescriptor;
	offset: number;
	byteLength: number;
	eof: boolean;
	encoding: "base64";
	data: string;
}

export interface ArtifactExportResult {
	path: string;
	byteLength: number;
	sha256: string;
	verified: true;
}

interface ArtifactMetadata {
	version: 1;
	id: string;
	toolName: string;
	source: ArtifactProvenanceSource;
	mediaType: string;
	related: ArtifactAllocationContext;
	cancellation: {
		cancelled: boolean;
		reason?: string;
	};
}

export class ArtifactNotFoundError extends Error {
	readonly code = "artifact_not_found";

	constructor(id: string) {
		super(`Artifact does not exist: ${id}`);
		this.name = "ArtifactNotFoundError";
	}
}

export class ArtifactRangeError extends Error {
	readonly code = "invalid_artifact_range";

	constructor(message: string) {
		super(message);
		this.name = "ArtifactRangeError";
	}
}

export class ArtifactHashMismatchError extends Error {
	readonly code = "artifact_hash_mismatch";

	constructor(expected: string, actual: string) {
		super(`Artifact hash mismatch: expected ${expected}, received ${actual}`);
		this.name = "ArtifactHashMismatchError";
	}
}

/**
 * Sanitize a tool name for safe use as the middle segment of the artifact
 * filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP,
 * extension, and RPC-host tool names are arbitrary and may contain path
 * separators (`/`, `\`) or traversal sequences (`..`) that would otherwise let
 * a spilled artifact escape the artifacts directory.
 */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

function validateArtifactId(id: string): void {
	if (!ARTIFACT_ID_RE.test(id)) throw new ArtifactNotFoundError(id);
}

function artifactFileMatch(id: string, file: string): RegExpMatchArray | null {
	const match = file.match(/^(\d+)\.([A-Za-z0-9_-]+)\.log$/);
	return match?.[1] === id ? match : null;
}

function metadataFileMatch(id: string, file: string): RegExpMatchArray | null {
	const match = file.match(/^(\d+)\.([A-Za-z0-9_-]+)\.meta\.json$/);
	return match?.[1] === id ? match : null;
}

function metadataFromUnknown(value: unknown, id: string, fallbackToolName: string): ArtifactMetadata {
	if (!isRecord(value)) return defaultMetadata(id, fallbackToolName);
	const relatedValue = isRecord(value.related) ? value.related : {};
	const cancellationValue = isRecord(value.cancellation) ? value.cancellation : {};
	const toolName = stringProperty(value, "toolName") ?? fallbackToolName;
	const source: ArtifactProvenanceSource =
		value.source === "collaboration_media" ? "collaboration_media" : "tool_output";
	const related: ArtifactAllocationContext = {
		...(typeof relatedValue.sessionId === "string" ? { sessionId: relatedValue.sessionId } : {}),
		...(typeof relatedValue.turnId === "string" ? { turnId: relatedValue.turnId } : {}),
		...(typeof relatedValue.toolCallId === "string" ? { toolCallId: relatedValue.toolCallId } : {}),
	};
	return {
		version: ARTIFACT_METADATA_VERSION,
		id,
		toolName,
		source,
		mediaType: stringProperty(value, "mediaType") ?? ARTIFACT_MEDIA_TYPE,
		related,
		cancellation: {
			cancelled: cancellationValue.cancelled === true,
			...(typeof cancellationValue.reason === "string" ? { reason: cancellationValue.reason } : {}),
		},
	};
}

function defaultMetadata(
	id: string,
	toolName: string,
	related: ArtifactAllocationContext = {},
	options: ArtifactAllocationOptions = {},
): ArtifactMetadata {
	return {
		version: ARTIFACT_METADATA_VERSION,
		id,
		toolName,
		source: options.source ?? "tool_output",
		mediaType: options.mediaType ?? ARTIFACT_MEDIA_TYPE,
		related,
		cancellation: { cancelled: false },
	};
}

async function hashFile(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const reader = Bun.file(filePath).stream().getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			hasher.update(value);
		}
	} finally {
		reader.releaseLock();
	}
	return hasher.digest("hex");
}

/**
 * Session-scoped artifact authority. Sequential ids remain stable across
 * resume; sidecar metadata preserves provenance without changing artifact://
 * compatibility. Content reads are range-bounded and binary-safe.
 */
export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initPromise: Promise<void> | null = null;

	constructor(dir: string) {
		this.#dir = dir;
	}

	get dir(): string {
		return this.#dir;
	}

	async #ensureDir(): Promise<void> {
		if (!this.#dirCreated) {
			await fs.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		this.#initPromise ??= this.#scanExistingIds();
		await this.#initPromise;
	}

	async #scanExistingIds(): Promise<void> {
		const files = await this.listFiles();
		let maxId = -1;
		for (const file of files) {
			const match = file.match(/^(\d+)\..*\.(?:log|meta\.json)$/);
			if (!match) continue;
			const id = Number.parseInt(match[1], 10);
			if (id > maxId) maxId = id;
		}
		this.#nextId = maxId + 1;
	}

	allocateId(): number {
		return this.#nextId++;
	}

	async allocatePath(
		toolType: string,
		related: ArtifactAllocationContext = {},
		options: ArtifactAllocationOptions = {},
	): Promise<{ id: string; path: string }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
		const toolName = sanitizeToolType(toolType);
		const artifactPath = path.join(this.#dir, `${id}.${toolName}.log`);
		await this.#writeMetadata(defaultMetadata(id, toolName, related, options));
		return { id, path: artifactPath };
	}

	async save(content: string, toolType: string, related: ArtifactAllocationContext = {}): Promise<string> {
		const allocation = await this.allocatePath(toolType, related);
		await Bun.write(allocation.path, content);
		return allocation.id;
	}

	async exists(id: string): Promise<boolean> {
		return (await this.getPath(id)) !== null;
	}

	async listFiles(): Promise<string[]> {
		try {
			return await fs.readdir(this.#dir);
		} catch (cause) {
			if (isEnoent(cause)) return [];
			throw cause;
		}
	}

	async getPath(id: string): Promise<string | null> {
		validateArtifactId(id);
		const files = await this.listFiles();
		const match = files.find(file => artifactFileMatch(id, file));
		return match ? path.join(this.#dir, match) : null;
	}

	async describe(id: string): Promise<ArtifactDescriptor> {
		validateArtifactId(id);
		const files = await this.listFiles();
		const artifactFile = files.find(file => artifactFileMatch(id, file));
		const metadataFile = files.find(file => metadataFileMatch(id, file));
		if (!artifactFile && !metadataFile) throw new ArtifactNotFoundError(id);
		const fallbackToolName =
			(artifactFile && artifactFileMatch(id, artifactFile)?.[2]) ??
			(metadataFile && metadataFileMatch(id, metadataFile)?.[2]) ??
			"tool";
		const metadata = metadataFile
			? await this.#readMetadata(path.join(this.#dir, metadataFile), id, fallbackToolName)
			: defaultMetadata(id, fallbackToolName);
		let byteLength: number | null = null;
		let sha256: string | null = null;
		if (artifactFile) {
			const artifactPath = path.join(this.#dir, artifactFile);
			const stats = await fs.stat(artifactPath);
			byteLength = stats.size;
			sha256 = await hashFile(artifactPath);
		}
		return {
			id,
			mediaType: metadata.mediaType,
			byteLength,
			sha256,
			provenance:
				metadata.source === "collaboration_media"
					? { source: "collaboration_media" }
					: { source: "tool_output", toolName: metadata.toolName },
			related: metadata.related,
			lifecycle: metadata.cancellation.cancelled ? "cancelled" : artifactFile ? "available" : "pending",
			cancellation: metadata.cancellation,
		};
	}

	async readRange(id: string, range: { offset: number; length: number }): Promise<ArtifactRange> {
		if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
			throw new ArtifactRangeError("Artifact range offset must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(range.length) || range.length < 1 || range.length > MAX_ARTIFACT_RANGE_BYTES) {
			throw new ArtifactRangeError(`Artifact range length must be between 1 and ${MAX_ARTIFACT_RANGE_BYTES} bytes`);
		}
		const descriptor = await this.describe(id);
		const artifactPath = await this.getPath(id);
		if (!artifactPath || descriptor.byteLength === null) throw new ArtifactNotFoundError(id);
		const end = Math.min(descriptor.byteLength, range.offset + range.length);
		let bytes = Buffer.alloc(0);
		if (range.offset < descriptor.byteLength) {
			const length = end - range.offset;
			const handle = await fs.open(artifactPath, "r");
			try {
				const buffer = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(buffer, 0, length, range.offset);
				bytes = buffer.subarray(0, bytesRead);
			} finally {
				await handle.close();
			}
		}
		return {
			descriptor,
			offset: range.offset,
			byteLength: bytes.byteLength,
			eof: end >= descriptor.byteLength,
			encoding: "base64",
			data: bytes.toString("base64"),
		};
	}

	async exportTo(id: string, destination: string, expectedSha256: string): Promise<ArtifactExportResult> {
		if (!SHA256_RE.test(expectedSha256)) {
			throw new ArtifactHashMismatchError(expectedSha256, "invalid expected SHA-256");
		}
		const descriptor = await this.describe(id);
		const source = await this.getPath(id);
		if (!source || descriptor.byteLength === null || descriptor.sha256 === null) {
			throw new ArtifactNotFoundError(id);
		}
		if (descriptor.sha256 !== expectedSha256) {
			throw new ArtifactHashMismatchError(expectedSha256, descriptor.sha256);
		}
		const temporary = `${destination}.omp-${crypto.randomUUID()}.tmp`;
		try {
			await fs.copyFile(source, temporary);
			const copiedHash = await hashFile(temporary);
			if (copiedHash !== expectedSha256) {
				throw new ArtifactHashMismatchError(expectedSha256, copiedHash);
			}
			await fs.rename(temporary, destination);
		} catch (cause) {
			await fs.rm(temporary, { force: true });
			throw cause;
		}
		return {
			path: destination,
			byteLength: descriptor.byteLength,
			sha256: descriptor.sha256,
			verified: true,
		};
	}

	async cancel(id: string, reason: string): Promise<void> {
		const descriptor = await this.describe(id);
		const artifactPath = await this.getPath(id);
		const toolName = artifactPath ? (artifactFileMatch(id, path.basename(artifactPath))?.[2] ?? "tool") : "tool";
		const metadata: ArtifactMetadata = {
			version: ARTIFACT_METADATA_VERSION,
			id,
			toolName,
			source: descriptor.provenance.source,
			mediaType: descriptor.mediaType,
			related: descriptor.related,
			cancellation: { cancelled: true, reason },
		};
		await this.#writeMetadata(metadata);
	}

	async #readMetadata(filePath: string, id: string, fallbackToolName: string): Promise<ArtifactMetadata> {
		try {
			const value: unknown = JSON.parse(await Bun.file(filePath).text());
			return metadataFromUnknown(value, id, fallbackToolName);
		} catch (cause) {
			if (isEnoent(cause) || cause instanceof SyntaxError) return defaultMetadata(id, fallbackToolName);
			throw cause;
		}
	}

	async #writeMetadata(metadata: ArtifactMetadata): Promise<void> {
		const metadataPath = path.join(this.#dir, `${metadata.id}.${metadata.toolName}.meta.json`);
		await Bun.write(metadataPath, JSON.stringify(metadata));
	}
}
