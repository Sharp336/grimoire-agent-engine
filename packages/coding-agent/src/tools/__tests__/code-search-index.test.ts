import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type CodeChunk, ZVecCodeStore } from "@oh-my-pi/pi-mnemopi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe.skipIf(!ZVecCodeStore.available())("ZVecCodeStore edit-then-reindex", () => {
	let tempDir: string;
	let store: ZVecCodeStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "zvec-code-search-"));
		// ZVecCreateAndOpen requires a path that does not yet exist.
		store = ZVecCodeStore.create(path.join(tempDir, "index"), 384);
	});

	afterEach(async () => {
		store.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeChunk(filePath: string, content: string, fileHash: string): CodeChunk {
		return {
			id: `${fileHash}-1`,
			filePath,
			language: "typescript",
			lineStart: 1,
			lineEnd: 1,
			content,
			chunkHash: Bun.hash(content).toString(16),
			embedding: [],
		};
	}

	test("upserting new chunks after removeFile does not leave stale chunks", () => {
		const filePath = "src/test.ts";
		const oldContent = "function foo() { return 1; }";
		const newContent = "function bar() { return 2; }";

		// Step 1: Upsert initial chunk.
		const oldHash = Bun.hash(oldContent).toString(16);
		store.upsertChunks([makeChunk(filePath, oldContent, oldHash)]);
		store.optimize();
		expect(store.docCount).toBe(1);

		// Step 2: Verify search finds the old content.
		const fooResults = store.searchFts("foo", 10);
		expect(fooResults.length).toBe(1);
		expect(fooResults[0]!.content).toContain("foo");

		// Step 3: Simulate an edit — remove old chunks, then upsert new ones.
		store.removeFile(filePath);
		const newHash = Bun.hash(newContent).toString(16);
		store.upsertChunks([makeChunk(filePath, newContent, newHash)]);
		store.optimize();

		// Step 4: docCount should be 1 (not 2 — no stale chunks).
		expect(store.docCount).toBe(1);

		// Step 5: Search for "foo" should return nothing (old chunk deleted).
		const staleResults = store.searchFts("foo", 10);
		expect(staleResults.length).toBe(0);

		// Step 6: Search for "bar" should return the new chunk.
		const barResults = store.searchFts("bar", 10);
		expect(barResults.length).toBe(1);
		expect(barResults[0]!.content).toContain("bar");
		expect(barResults[0]!.filePath).toBe(filePath);
	});

	test("getFileHashes reflects current chunks after re-indexing", () => {
		const filePath = "src/utils.ts";
		const oldContent = "export function add(a, b) { return a + b; }";
		const newContent = "export function multiply(a, b) { return a * b; }";

		// Index initial content.
		const oldHash = Bun.hash(oldContent).toString(16);
		store.upsertChunks([makeChunk(filePath, oldContent, oldHash)]);
		store.optimize();

		let hashes = store.getFileHashes();
		expect(hashes.has(filePath)).toBe(true);
		expect(hashes.get(filePath)!.size).toBe(1);

		// Re-index with changed content.
		store.removeFile(filePath);
		const newHash = Bun.hash(newContent).toString(16);
		store.upsertChunks([makeChunk(filePath, newContent, newHash)]);
		store.optimize();

		// getFileHashes should reflect only the new chunk hash.
		hashes = store.getFileHashes();
		expect(hashes.get(filePath)!.size).toBe(1);
		const currentHashes = hashes.get(filePath)!;
		const newChunkHash = Bun.hash(newContent).toString(16);
		expect(currentHashes.has(newChunkHash)).toBe(true);
	});
});
