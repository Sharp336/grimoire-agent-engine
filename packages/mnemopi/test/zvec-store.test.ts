import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { zvecChunkOverlap, zvecChunkSize, zvecCodeIndexPath, zvecEnabled, zvecTopK } from "../src/core/zvec-config";
import { type CodeChunk, ZVecCodeStore } from "../src/core/zvec-store";

const ZVEC_AVAILABLE = ZVecCodeStore.available();

/** Create a temp directory path for a Zvec collection (does not create the dir — Zvec creates it). */
async function makeTempDir(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zvec-test-"));
	return path.join(parent, "collection");
}

/** Recursively remove a directory (and its parent), ignoring errors. */
async function cleanupDir(dir: string): Promise<void> {
	// `dir` is <parent>/collection — remove the parent to clean everything.
	const parent = path.dirname(dir);
	await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
}

function makeChunk(overrides: Partial<CodeChunk> & { id: string }): CodeChunk {
	return {
		filePath: `src/${overrides.id}.ts`,
		language: "typescript",
		lineStart: 1,
		lineEnd: 10,
		content: `// chunk ${overrides.id}`,
		chunkHash: `hash-${overrides.id}`,
		embedding: [0.1, 0.2, 0.3, 0.4],
		...overrides,
	};
}

afterEach(() => {
	// No global state to restore — ZVecCodeStore is instance-based.
	// This hook exists to satisfy the full-suite-safe contract.
});

describe("ZVecCodeStore.available", () => {
	it("returns a boolean", () => {
		const result = ZVecCodeStore.available();
		expect(typeof result).toBe("boolean");
	});
});

describe("zvec-config", () => {
	it("returns default values", () => {
		expect(zvecEnabled()).toBe(true);
		expect(zvecChunkSize()).toBe(100);
		expect(zvecChunkOverlap()).toBe(10);
		expect(zvecTopK()).toBe(20);
		expect(zvecCodeIndexPath()).toContain("zvec");
		expect(zvecCodeIndexPath()).toContain("code-index");
	});

	it("respects environment overrides", () => {
		const savedChunkSize = process.env.OMP_ZVEC_CHUNK_SIZE;
		const savedTopK = process.env.OMP_ZVEC_TOP_K;
		const savedEnabled = process.env.OMP_ZVEC_ENABLED;

		process.env.OMP_ZVEC_CHUNK_SIZE = "200";
		process.env.OMP_ZVEC_TOP_K = "50";
		process.env.OMP_ZVEC_ENABLED = "false";

		expect(zvecChunkSize()).toBe(200);
		expect(zvecTopK()).toBe(50);
		expect(zvecEnabled()).toBe(false);

		// Restore
		if (savedChunkSize !== undefined) process.env.OMP_ZVEC_CHUNK_SIZE = savedChunkSize;
		else delete process.env.OMP_ZVEC_CHUNK_SIZE;
		if (savedTopK !== undefined) process.env.OMP_ZVEC_TOP_K = savedTopK;
		else delete process.env.OMP_ZVEC_TOP_K;
		if (savedEnabled !== undefined) process.env.OMP_ZVEC_ENABLED = savedEnabled;
		else delete process.env.OMP_ZVEC_ENABLED;
	});
});

describe.skipIf(!ZVEC_AVAILABLE)("ZVecCodeStore lifecycle", () => {
	let store: ZVecCodeStore;
	let dir: string;

	afterEach(async () => {
		if (store) {
			store.close();
		}
		if (dir) {
			await cleanupDir(dir);
		}
	});

	it("creates a collection, upserts chunks, and searches by vector", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);

		const chunks: CodeChunk[] = [
			makeChunk({
				id: "a_1",
				filePath: "src/foo.ts",
				content: "export function add(a, b) { return a + b }",
				embedding: [1, 0, 0, 0],
				lineStart: 1,
				lineEnd: 1,
				chunkHash: "h1",
			}),
			makeChunk({
				id: "b_1",
				filePath: "src/bar.ts",
				content: "export class Calculator { multiply(x, y) { return x * y } }",
				embedding: [0, 1, 0, 0],
				lineStart: 1,
				lineEnd: 1,
				chunkHash: "h2",
			}),
		];

		store.upsertChunks(chunks);
		store.optimize();

		expect(store.docCount).toBe(2);

		const results = store.search([1, 0, 0, 0], 2);
		expect(results.length).toBe(2);
		expect(results[0].id).toBe("a_1");
		expect(results[0].filePath).toBe("src/foo.ts");
		expect(results[0].language).toBe("typescript");
		expect(results[0].lineStart).toBe(1);
		expect(results[0].lineEnd).toBe(1);
		expect(results[0].content).toContain("add");
		expect(results[0].chunkHash).toBe("h1");
		// Zvec COSINE returns a distance (0 = identical vectors), not a similarity.
		expect(results[0].score).toBe(0);
		// The orthogonal vector should have a higher distance.
		expect(results[1].score).toBeGreaterThan(results[0].score);
	});

	it("performs full-text search (BM25)", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);

		store.upsertChunks([
			makeChunk({
				id: "fts1",
				filePath: "src/search.ts",
				content: "binary search tree implementation",
				embedding: [0.1, 0.2, 0.3, 0.4],
				chunkHash: "fh1",
			}),
			makeChunk({
				id: "fts2",
				filePath: "src/graph.ts",
				content: "depth first graph traversal",
				embedding: [0.5, 0.6, 0.7, 0.8],
				chunkHash: "fh2",
			}),
		]);
		store.optimize();

		const results = store.searchFts("search", 10);
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].id).toBe("fts1");
		expect(results[0].content).toContain("search");
		expect(results[0].filePath).toBe("src/search.ts");
		expect(results[0].score).toBeGreaterThan(0);
	});

	it("performs hybrid search combining vector and FTS", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);

		store.upsertChunks([
			makeChunk({
				id: "hyb1",
				filePath: "src/vector.ts",
				content: "vector dot product cosine similarity",
				embedding: [1, 0, 0, 0],
				chunkHash: "hh1",
			}),
			makeChunk({
				id: "hyb2",
				filePath: "src/parser.ts",
				content: "recursive descent parser tokenizer",
				embedding: [0, 1, 0, 0],
				chunkHash: "hh2",
			}),
		]);
		store.optimize();

		const results = store.searchHybrid({ vector: [1, 0, 0, 0], fts: "vector" }, 10);
		expect(results.length).toBeGreaterThanOrEqual(1);
		// The doc matching both signals should be first.
		expect(results[0].id).toBe("hyb1");

		// Every result has a valid score.
		for (const r of results) {
			expect(Number.isFinite(r.score)).toBe(true);
		}
	});

	it("removes all chunks for a given file path", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);

		store.upsertChunks([
			makeChunk({
				id: "rm1",
				filePath: "src/remove.ts",
				content: "first chunk",
				embedding: [1, 0, 0, 0],
				chunkHash: "rh1",
			}),
			makeChunk({
				id: "rm2",
				filePath: "src/remove.ts",
				content: "second chunk",
				embedding: [0, 1, 0, 0],
				chunkHash: "rh2",
			}),
			makeChunk({
				id: "rm3",
				filePath: "src/keep.ts",
				content: "keep this",
				embedding: [0, 0, 1, 0],
				chunkHash: "rh3",
			}),
		]);
		store.optimize();

		expect(store.docCount).toBe(3);

		store.removeFile("src/remove.ts");

		expect(store.docCount).toBe(1);

		const results = store.search([0, 0, 1, 0], 10);
		expect(results.length).toBe(1);
		expect(results[0].id).toBe("rm3");
		expect(results[0].filePath).toBe("src/keep.ts");
	});

	it("returns correct file_path → chunk_hash mappings from getFileHashes", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);

		store.upsertChunks([
			makeChunk({ id: "fh-a1", filePath: "src/a.ts", chunkHash: "hash-a1", embedding: [1, 0, 0, 0] }),
			makeChunk({ id: "fh-a2", filePath: "src/a.ts", chunkHash: "hash-a2", embedding: [0, 1, 0, 0] }),
			makeChunk({ id: "fh-b1", filePath: "src/b.ts", chunkHash: "hash-b1", embedding: [0, 0, 1, 0] }),
		]);
		store.optimize();

		const hashes = store.getFileHashes();

		expect(hashes.size).toBe(2);
		expect(hashes.has("src/a.ts")).toBe(true);
		expect(hashes.has("src/b.ts")).toBe(true);

		const aHashes = hashes.get("src/a.ts");
		expect(aHashes).not.toBeUndefined();
		expect(aHashes?.size).toBe(2);
		expect(aHashes?.has("hash-a1")).toBe(true);
		expect(aHashes?.has("hash-a2")).toBe(true);

		const bHashes = hashes.get("src/b.ts");
		expect(bHashes?.size).toBe(1);
		expect(bHashes?.has("hash-b1")).toBe(true);
	});

	it("handles file paths with single quotes in removeFile", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);

		const trickyPath = "src/it's a file.ts";
		store.upsertChunks([
			makeChunk({
				id: "sq1",
				filePath: trickyPath,
				content: "quoted path",
				embedding: [1, 0, 0, 0],
				chunkHash: "qh1",
			}),
			makeChunk({
				id: "sq2",
				filePath: "src/normal.ts",
				content: "normal path",
				embedding: [0, 1, 0, 0],
				chunkHash: "qh2",
			}),
		]);
		store.optimize();

		expect(store.docCount).toBe(2);

		store.removeFile(trickyPath);

		expect(store.docCount).toBe(1);
		const results = store.search([0, 1, 0, 0], 10);
		expect(results.length).toBe(1);
		expect(results[0].filePath).toBe("src/normal.ts");
	});

	it("opens an existing collection with open()", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);
		store.upsertChunks([
			makeChunk({
				id: "open1",
				filePath: "src/open.ts",
				content: "persisted content",
				embedding: [1, 0, 0, 0],
				chunkHash: "oh1",
			}),
		]);
		store.optimize();
		store.close();

		// Reopen
		const reopened = ZVecCodeStore.open(dir);
		expect(reopened.docCount).toBe(1);

		const results = reopened.search([1, 0, 0, 0], 1);
		expect(results.length).toBe(1);
		expect(results[0].id).toBe("open1");
		expect(results[0].content).toBe("persisted content");

		reopened.close();
	});

	it("returns empty array for search with empty query embedding", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);
		store.upsertChunks([
			makeChunk({ id: "empty1", filePath: "src/e.ts", content: "some content", embedding: [1, 0, 0, 0] }),
		]);
		store.optimize();

		const results = store.search([], 10);
		expect(results).toEqual([]);
	});

	it("returns empty array for FTS with empty query string", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);
		store.upsertChunks([
			makeChunk({ id: "emptyfts1", filePath: "src/e.ts", content: "some content", embedding: [1, 0, 0, 0] }),
		]);
		store.optimize();

		const results = store.searchFts("   ", 10);
		expect(results).toEqual([]);
	});

	it("returns empty array for hybrid with no vector and no fts", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);
		store.upsertChunks([
			makeChunk({ id: "hybempty", filePath: "src/e.ts", content: "content", embedding: [1, 0, 0, 0] }),
		]);
		store.optimize();

		expect(store.searchHybrid({}, 10)).toEqual([]);
		expect(store.searchHybrid({ vector: [] }, 10)).toEqual([]);
		expect(store.searchHybrid({ fts: "  " }, 10)).toEqual([]);
	});

	it("upserts chunks without embeddings (FTS-only)", async () => {
		dir = await makeTempDir();
		store = ZVecCodeStore.create(dir, 4);

		const chunkNoEmbed: CodeChunk = {
			id: "noembed1",
			filePath: "src/noembed.ts",
			language: "typescript",
			lineStart: 1,
			lineEnd: 5,
			content: "function without embedding",
			chunkHash: "neh1",
			embedding: [],
		};

		store.upsertChunks([chunkNoEmbed]);
		store.optimize();

		expect(store.docCount).toBe(1);

		// FTS still works
		const ftsResults = store.searchFts("without", 10);
		expect(ftsResults.length).toBe(1);
		expect(ftsResults[0].id).toBe("noembed1");
	});
});
