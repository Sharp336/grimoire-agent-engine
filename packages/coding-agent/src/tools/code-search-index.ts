import * as path from "node:path";
import type * as MnemopiNs from "@oh-my-pi/pi-mnemopi";
import type { CodeChunk, ZVecCodeStore } from "@oh-my-pi/pi-mnemopi";
import { FileType, listWorkspace } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { loadMnemopi } from "../mnemopi/state";
import {
	chunkFile,
	detectLanguage,
	isBinaryContent,
	isIndexableFile,
	MAX_FILE_SIZE,
	SKIP_DIRECTORIES,
} from "./code-search-helpers";
import { throwIfAborted } from "./tool-errors";

export interface IndexResult {
	totalFiles: number;
	filesIndexed: number;
	chunksIndexed: number;
	duration: number;
}

export async function indexWorkspace(cwd: string, signal?: AbortSignal): Promise<IndexResult> {
	const start = Date.now();
	const mnemopi: typeof MnemopiNs = await loadMnemopi();

	if (!mnemopi.ZVecCodeStore.available()) {
		throw new Error("Code search requires @zvec/zvec. Install it with: bun add @zvec/zvec");
	}

	const indexPath = mnemopi.zvecCodeIndexPath();
	const model = mnemopi.currentEmbeddingModel();
	const dimension = mnemopi.embeddingDimFor(model);

	let store: ZVecCodeStore;
	try {
		store = mnemopi.ZVecCodeStore.open(indexPath);
	} catch {
		store = mnemopi.ZVecCodeStore.create(indexPath, dimension);
	}

	const sourceFiles = await collectSourceFiles(cwd, signal);
	if (sourceFiles.length === 0) {
		return { totalFiles: 0, filesIndexed: 0, chunksIndexed: 0, duration: Date.now() - start };
	}

	const storeFileHashes = store.getFileHashes();
	const indexedPaths = new Set(storeFileHashes.keys());

	const chunksToUpsert: CodeChunk[] = [];
	const filesToRemove: string[] = [];
	const currentFiles = new Set<string>();
	const chunkSize = mnemopi.zvecChunkSize();
	const overlap = mnemopi.zvecChunkOverlap();
	const canEmbed = await mnemopi.available();

	let filesIndexed = 0;

	for (const filePath of sourceFiles) {
		throwIfAborted(signal);

		const file = Bun.file(filePath);
		const exists = await file.exists();
		if (!exists) continue;

		const stat = await file.stat();
		if (stat.size > MAX_FILE_SIZE) {
			// File grew too large — remove any existing chunks.
			if (storeFileHashes.has(filePath)) store.removeFile(filePath);
			continue;
		}

		const buffer = Buffer.from(await file.arrayBuffer());
		if (isBinaryContent(buffer)) {
			// File became binary — remove any existing chunks.
			if (storeFileHashes.has(filePath)) store.removeFile(filePath);
			continue;
		}

		// Only mark as current after confirming it's indexable.
		currentFiles.add(filePath);

		const content = buffer.toString("utf-8");
		const fileHash = Bun.hash(`${filePath}\0${content}`).toString(16);

		const chunks = chunkFile(content, chunkSize, overlap);
		const newChunkHashes = new Set(chunks.map(c => Bun.hash(c.content).toString(16)));

		const indexedHashes = storeFileHashes.get(filePath);
		if (indexedHashes !== undefined) {
			if (setsEqual(indexedHashes, newChunkHashes)) continue;
			store.removeFile(filePath);
		}

		const language = detectLanguage(filePath);
		const batchSize = 32;
		for (let i = 0; i < chunks.length; i += batchSize) {
			throwIfAborted(signal);
			const batch = chunks.slice(i, i + batchSize);
			let embeddings: Float32Array[] | null = null;
			if (canEmbed) {
				try {
					embeddings = await mnemopi.embed(batch.map(c => c.content));
				} catch (err) {
					logger.debug("code_search: embedding batch failed", { error: String(err) });
				}
			}

			for (let j = 0; j < batch.length; j++) {
				const chunk = batch[j]!;
				chunksToUpsert.push({
					id: `${fileHash}-${chunk.lineStart}`,
					filePath,
					language,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					content: chunk.content,
					chunkHash: Bun.hash(chunk.content).toString(16),
					embedding: embeddings?.[j] ? Array.from(embeddings[j]!) : [],
				});
			}
		}

		filesIndexed++;
	}

	for (const indexedPath of indexedPaths) {
		if (!currentFiles.has(indexedPath)) {
			filesToRemove.push(indexedPath);
		}
	}

	for (const filePath of filesToRemove) {
		store.removeFile(filePath);
	}

	if (chunksToUpsert.length > 0) {
		store.upsertChunks(chunksToUpsert);
	}

	if (chunksToUpsert.length > 0 || filesToRemove.length > 0) {
		store.optimize();
	}

	return {
		totalFiles: sourceFiles.length,
		filesIndexed,
		chunksIndexed: chunksToUpsert.length,
		duration: Date.now() - start,
	};
}

async function collectSourceFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const result = await listWorkspace({
		path: cwd,
		maxDepth: 20,
		gitignore: true,
		hidden: false,
		signal,
	});

	const files: string[] = [];
	for (const entry of result.entries) {
		if (entry.fileType !== FileType.File) continue;
		if (!isIndexableFile(entry.path)) continue;
		if (entry.size !== undefined && entry.size > MAX_FILE_SIZE) continue;

		const parts = entry.path.split("/");
		if (parts.some(p => SKIP_DIRECTORIES.has(p))) continue;

		files.push(path.join(cwd, entry.path));
	}
	return files;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}
