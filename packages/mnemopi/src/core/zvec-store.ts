import { createRequire } from "node:module";
import { logger } from "@oh-my-pi/pi-utils";
import type { ZVecCollection, ZVecDocInput, ZVecMultiQuery, ZVecQuery } from "@zvec/zvec";

/**
 * Module-level cache of the `@zvec/zvec` native addon.
 *
 * The module is an optional peer dependency — it carries a native addon that
 * may be absent at runtime. We load it once via `createRequire` (synchronous in
 * Bun) and cache the result so that all subsequent operations are sync.
 */
let zvecModule: typeof import("@zvec/zvec") | null | undefined;

/**
 * Synchronously load (and cache) the `@zvec/zvec` native module.
 * Returns `null` when the package is not installed.
 */
function getZvec(): typeof import("@zvec/zvec") | null {
	if (zvecModule !== undefined) return zvecModule;
	try {
		const require = createRequire(import.meta.url);
		zvecModule = require("@zvec/zvec") as typeof import("@zvec/zvec");
	} catch (error) {
		logger.debug("zvec: @zvec/zvec native module not available", { error: String(error) });
		zvecModule = null;
	}
	return zvecModule;
}

/** A code chunk with its pre-computed embedding vector. */
export interface CodeChunk {
	/** Unique chunk ID (e.g. `${fileHash}-${lineStart}`). Must not contain `:`, `/`, or `|` — Zvec rejects those characters. */
	id: string;
	/** Relative file path. */
	filePath: string;
	/** Programming language. */
	language: string;
	/** Start line (1-based, inclusive). */
	lineStart: number;
	/** End line (1-based, inclusive). */
	lineEnd: number;
	/** Code text. */
	content: string;
	/** Hash of the content. */
	chunkHash: string;
	/** Pre-computed embedding vector. */
	embedding: number[];
}

/** A search result from the vector store. */
export interface ZVecSearchResult {
	id: string;
	filePath: string;
	language: string;
	lineStart: number;
	lineEnd: number;
	content: string;
	chunkHash: string;
	score: number;
}

/** Names of scalar fields stored in the Zvec collection. */
const FIELD_FILE_PATH = "file_path";
const FIELD_LANGUAGE = "language";
const FIELD_LINE_START = "line_start";
const FIELD_LINE_END = "line_end";
const FIELD_CONTENT = "content";
const FIELD_CHUNK_HASH = "chunk_hash";
const VECTOR_FIELD = "embedding";

/** All scalar field names, for output projection. */
const ALL_FIELDS = [
	FIELD_FILE_PATH,
	FIELD_LANGUAGE,
	FIELD_LINE_START,
	FIELD_LINE_END,
	FIELD_CONTENT,
	FIELD_CHUNK_HASH,
] as const;

/** Maximum topk Zvec allows in a single query (enforced by the native engine). */
const ZVEC_MAX_TOPK = 100_000;

/** Convert a ZVecDoc (with `fields: Record<string, any>`) into a typed result. */
function docToResult(doc: { id: string; fields: Record<string, unknown>; score: number }): ZVecSearchResult {
	const f = doc.fields;
	return {
		id: doc.id,
		filePath: String(f[FIELD_FILE_PATH] ?? ""),
		language: String(f[FIELD_LANGUAGE] ?? ""),
		lineStart: Number(f[FIELD_LINE_START] ?? 0),
		lineEnd: Number(f[FIELD_LINE_END] ?? 0),
		content: String(f[FIELD_CONTENT] ?? ""),
		chunkHash: String(f[FIELD_CHUNK_HASH] ?? ""),
		score: doc.score,
	};
}

/**
 * A vector store for code chunks backed by Zvec (`@zvec/zvec`).
 *
 * This is a pure vector-DB wrapper — it stores and searches pre-computed
 * embeddings. Embedding computation is the caller's responsibility.
 */
export class ZVecCodeStore {
	#collection: ZVecCollection;
	#dimension: number;

	constructor(collection: ZVecCollection, dimension: number) {
		this.#collection = collection;
		this.#dimension = dimension;
	}

	/**
	 * Create and open a new Zvec collection at the given path.
	 * @param path Directory for the collection files.
	 * @param dimension Embedding vector dimension (must match the embedding model).
	 */
	static create(path: string, dimension: number): ZVecCodeStore {
		const zvec = getZvec();
		if (!zvec) {
			throw new Error("@zvec/zvec is not installed. Install it with: bun add @zvec/zvec");
		}

		const schema = new zvec.ZVecCollectionSchema({
			name: "code_index",
			fields: [
				{
					name: FIELD_FILE_PATH,
					dataType: zvec.ZVecDataType.STRING,
					indexParams: { indexType: zvec.ZVecIndexType.INVERT },
				},
				{
					name: FIELD_LANGUAGE,
					dataType: zvec.ZVecDataType.STRING,
					indexParams: { indexType: zvec.ZVecIndexType.INVERT },
				},
				{ name: FIELD_LINE_START, dataType: zvec.ZVecDataType.INT32 },
				{ name: FIELD_LINE_END, dataType: zvec.ZVecDataType.INT32 },
				{
					name: FIELD_CHUNK_HASH,
					dataType: zvec.ZVecDataType.STRING,
					indexParams: { indexType: zvec.ZVecIndexType.INVERT },
				},
				{
					name: FIELD_CONTENT,
					dataType: zvec.ZVecDataType.STRING,
					nullable: false,
					indexParams: {
						indexType: zvec.ZVecIndexType.FTS,
						tokenizerName: "standard",
						filters: ["lowercase"],
					},
				},
			],
			vectors: [
				{
					name: VECTOR_FIELD,
					dataType: zvec.ZVecDataType.VECTOR_FP32,
					dimension,
					indexParams: { indexType: zvec.ZVecIndexType.HNSW, metricType: zvec.ZVecMetricType.COSINE },
				},
			],
		});

		const collection = zvec.ZVecCreateAndOpen(path, schema);
		return new ZVecCodeStore(collection, dimension);
	}

	/** Open an existing Zvec collection at the given path. */
	static open(path: string): ZVecCodeStore {
		const zvec = getZvec();
		if (!zvec) {
			throw new Error("@zvec/zvec is not installed. Install it with: bun add @zvec/zvec");
		}
		const collection = zvec.ZVecOpen(path);
		// Read the dimension from the collection schema.
		const vectorSchema = collection.schema.vectors().find(v => v.name === VECTOR_FIELD);
		const dimension = vectorSchema?.dimension ?? 0;
		return new ZVecCodeStore(collection, dimension);
	}

	/** Check if `@zvec/zvec` is available (installed and loadable). */
	static available(): boolean {
		return getZvec() !== null;
	}

	/** Upsert code chunks (batch). Chunks without embeddings get a zero vector (FTS-only). */
	upsertChunks(chunks: readonly CodeChunk[]): void {
		if (chunks.length === 0) return;
		const docs: ZVecDocInput[] = chunks.map(chunk => {
			const fields: Record<string, string | number> = {
				[FIELD_FILE_PATH]: chunk.filePath,
				[FIELD_LANGUAGE]: chunk.language,
				[FIELD_LINE_START]: chunk.lineStart,
				[FIELD_LINE_END]: chunk.lineEnd,
				[FIELD_CONTENT]: chunk.content,
				[FIELD_CHUNK_HASH]: chunk.chunkHash,
			};
			// The vector field is required by the Zvec schema. When no embedding
			// is provided, use a zero vector so the doc can still be stored for FTS.
			const embedding = chunk.embedding.length > 0 ? chunk.embedding : new Array(this.#dimension).fill(0);
			return { id: chunk.id, fields, vectors: { [VECTOR_FIELD]: embedding } };
		});
		this.#collection.upsertSync(docs);
	}

	/** Vector similarity search. Returns results sorted by descending score. */
	search(queryEmbedding: readonly number[], topK = 10): ZVecSearchResult[] {
		if (queryEmbedding.length === 0) return [];
		const query: ZVecQuery = {
			fieldName: VECTOR_FIELD,
			vector: [...queryEmbedding],
			topk: topK,
			outputFields: [...ALL_FIELDS],
		};
		const docs = this.#collection.querySync(query);
		return docs.map(docToResult);
	}

	/** Full-text search (BM25) over the `content` field. */
	searchFts(query: string, topK = 10): ZVecSearchResult[] {
		if (!query.trim()) return [];
		const zvecQuery: ZVecQuery = {
			fieldName: FIELD_CONTENT,
			fts: { matchString: query },
			topk: topK,
			outputFields: [...ALL_FIELDS],
		};
		const docs = this.#collection.querySync(zvecQuery);
		return docs.map(docToResult);
	}

	/**
	 * Hybrid search combining vector similarity and FTS.
	 * Uses Zvec's native `multiQuerySync` with reciprocal rank fusion (RRF).
	 */
	searchHybrid(query: { vector?: readonly number[]; fts?: string }, topK = 10): ZVecSearchResult[] {
		const subQueries: ZVecMultiQuery["queries"] = [];

		if (query.vector && query.vector.length > 0) {
			subQueries.push({
				fieldName: VECTOR_FIELD,
				vector: [...query.vector],
			});
		}

		if (query.fts?.trim()) {
			subQueries.push({
				fieldName: FIELD_CONTENT,
				fts: { matchString: query.fts },
			});
		}

		if (subQueries.length === 0) return [];
		if (subQueries.length === 1) {
			// Single query mode — use plain querySync for direct scores.
			const sq = subQueries[0];
			if (sq.fts) {
				return this.searchFts(query.fts ?? "", topK);
			}
			return this.search(query.vector ?? [], topK);
		}

		const multiQuery: ZVecMultiQuery = {
			queries: subQueries,
			topk: topK,
			outputFields: [...ALL_FIELDS],
			rerank: { type: "rrf", rankConstant: 60 },
		};

		const docs = this.#collection.multiQuerySync(multiQuery);
		return docs.map(docToResult);
	}

	/**
	 * Scan all documents in the collection, projecting only the requested scalar
	 * fields. Uses the maximum topk allowed by Zvec and warns if the cap is hit,
	 * which would indicate silent truncation.
	 */
	#scanAll(outputFields: readonly string[]): { id: string; fields: Record<string, unknown> }[] {
		const docs = this.#collection.querySync({
			filter: `${FIELD_FILE_PATH} LIKE '%'`,
			topk: ZVEC_MAX_TOPK,
			outputFields: [...outputFields],
		});
		if (docs.length >= ZVEC_MAX_TOPK) {
			logger.warn("zvec: scanAll hit the topk cap — results may be truncated", {
				returned: docs.length,
				cap: ZVEC_MAX_TOPK,
			});
		}
		return docs;
	}

	/** Remove all chunks for a given file path. */
	removeFile(filePath: string): void {
		// For paths without single quotes, use deleteByFilterSync directly —
		// it's precise and avoids scanning the collection.
		if (!filePath.includes("'")) {
			this.#collection.deleteByFilterSync(`${FIELD_FILE_PATH} = '${filePath}'`);
			return;
		}
		// Zvec's SQL filter parser mishandles single quotes inside `=`
		// comparisons, so for paths containing single quotes we scan and
		// delete by document ID instead.
		const docs = this.#scanAll([FIELD_FILE_PATH]);
		const idsToDelete: string[] = [];
		for (const doc of docs) {
			if (String(doc.fields[FIELD_FILE_PATH] ?? "") === filePath) {
				idsToDelete.push(doc.id);
			}
		}
		if (idsToDelete.length > 0) {
			this.#collection.deleteSync(idsToDelete);
		}
	}

	/**
	 * Get all distinct file_path → chunk_hash mappings for change detection.
	 * Returns a Map where each key is a file path and each value is the set of
	 * chunk hashes currently stored for that file.
	 */
	getFileHashes(): Map<string, Set<string>> {
		const result = new Map<string, Set<string>>();
		const docs = this.#scanAll([FIELD_FILE_PATH, FIELD_CHUNK_HASH]);
		for (const doc of docs) {
			const fp = String(doc.fields[FIELD_FILE_PATH] ?? "");
			const hash = String(doc.fields[FIELD_CHUNK_HASH] ?? "");
			if (!fp) continue;
			const hashes = result.get(fp) ?? new Set<string>();
			hashes.add(hash);
			result.set(fp, hashes);
		}
		return result;
	}

	/** Optimize the collection (build vector index). */
	optimize(): void {
		this.#collection.optimizeSync();
	}

	/** Get the current document count. */
	get docCount(): number {
		return this.#collection.stats.docCount;
	}

	/** Close the collection, releasing resources. */
	close(): void {
		this.#collection.closeSync();
	}
}
