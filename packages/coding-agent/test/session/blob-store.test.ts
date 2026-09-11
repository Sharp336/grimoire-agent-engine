import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BLOB_RANGE_BYTES,
	BlobStore,
	blobExtensionForImageMimeType,
	externalizeImageData,
	parseBlobRef,
	resolveImageData,
} from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("BlobStore image display paths", () => {
	it("creates an extension-bearing sidecar for image blobs while keeping canonical refs extensionless", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const result = await store.put(data, { extension: "png" });
		expect(result.path.endsWith(result.hash)).toBe(true);
		expect(result.displayPath).toBe(`${result.path}.png`);
		expect(result.ref).toBe(`blob:sha256:${result.hash}`);
		expect(await Bun.file(result.path).bytes()).toEqual(new Uint8Array(data));
		expect(await Bun.file(result.displayPath).bytes()).toEqual(new Uint8Array(data));
	});

	it("externalizes image data with a mime-derived display extension", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const ref = await externalizeImageData(store, data.toString("base64"), "image/webp");
		const hash = parseBlobRef(ref);

		expect(hash).toBeTruthy();
		expect(await Bun.file(`${tempDir.path()}/${hash}.webp`).bytes()).toEqual(new Uint8Array(data));
		expect(await resolveImageData(store, ref)).toBe(data.toString("base64"));
	});

	it("maps common image mime types to clickable file extensions", () => {
		expect(blobExtensionForImageMimeType("image/jpeg")).toBe("jpg");
		expect(blobExtensionForImageMimeType("image/png")).toBe("png");
		expect(blobExtensionForImageMimeType("text/plain")).toBeUndefined();
	});
});

describe("BlobStore bounded media reads", () => {
	it("reassembles exact binary bytes across ranges and distinguishes EOF from an absent blob", async () => {
		using tempDir = TempDir.createSync("@omp-blob-range-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from(Array.from({ length: BLOB_RANGE_BYTES * 2 + 17 }, (_, index) => index % 251));
		const { hash } = await store.put(data);
		const chunks: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const range = await store.getRange(hash, offset, BLOB_RANGE_BYTES);
			expect(range!.totalBytes).toBe(data.length);
			expect(range!.data).toEqual(data.subarray(offset, offset + BLOB_RANGE_BYTES));
			chunks.push(range!.data);
			if (range!.nextOffset === null) break;
			expect(range!.nextOffset).toBe(offset + BLOB_RANGE_BYTES);
			offset = range!.nextOffset;
		}
		expect(Buffer.concat(chunks)).toEqual(data);
		expect(await store.getRange(hash, data.length, 1)).toEqual({
			data: Buffer.alloc(0),
			totalBytes: data.length,
			nextOffset: null,
		});
		expect(await store.getRange("0".repeat(64), 0, 1)).toBeNull();
		await expect(store.getRange(hash, data.length + 1, 1)).rejects.toThrow("EOF");
		const empty = await store.put(Buffer.alloc(0));
		expect(await store.getRange(empty.hash, 0, 1)).toEqual({
			data: Buffer.alloc(0),
			totalBytes: 0,
			nextOffset: null,
		});
	});
	it("rejects traversal and unbounded, fractional or negative reads before filesystem access", async () => {
		using tempDir = TempDir.createSync("@omp-blob-range-");
		const store = new BlobStore(path.join(tempDir.path(), "missing"));
		await expect(store.getRange("../secret", 0, 1)).rejects.toThrow("hash");
		await expect(store.getRange("a".repeat(64), -1, 1)).rejects.toThrow("range");
		await expect(store.getRange("a".repeat(64), 0.5, 1)).rejects.toThrow("range");
		await expect(store.getRange("a".repeat(64), 0, 0)).rejects.toThrow("range");
		await expect(store.getRange("a".repeat(64), 0, BLOB_RANGE_BYTES + 1)).rejects.toThrow("range");
		await expect(store.getRange("a".repeat(64), Number.MAX_SAFE_INTEGER + 1, 1)).rejects.toThrow("range");
	});
	it("refuses a linked blob directory or a non-file instead of following it", async () => {
		using tempDir = TempDir.createSync("@omp-blob-range-");
		const actual = path.join(tempDir.path(), "actual");
		const store = new BlobStore(actual);
		const { hash } = await store.put(Buffer.from("private binary"));
		const linked = path.join(tempDir.path(), "linked");
		await fs.symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(new BlobStore(linked).getRange(hash, 0, 1)).rejects.toThrow("unsafe");
		} finally {
			await fs.unlink(linked);
		}
		await fs.mkdir(path.join(actual, "a".repeat(64)));
		await expect(store.getRange("a".repeat(64), 0, 1)).rejects.toThrow("unsafe");
	});
});

describe("BlobStore completed upload import", () => {
	it("publishes exact multi-chunk bytes, deduplicates retries, and preserves the staged source", async () => {
		using tempDir = TempDir.createSync("@omp-blob-upload-");
		const source = path.join(tempDir.path(), "upload.bin");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const data = Buffer.from(Array.from({ length: BLOB_RANGE_BYTES * 3 + 17 }, (_, index) => index % 251));
		const expected = { hash: new Bun.SHA256().update(data).digest("hex"), bytes: data.length };
		await Bun.write(source, data);
		const [first, retry] = await Promise.all([
			store.importFile(source, expected),
			store.importFile(source, expected),
		]);
		expect(retry.path).toBe(first.path);
		expect(first.ref).toBe(`blob:sha256:${expected.hash}`);
		expect(await fs.readFile(first.path)).toEqual(data);
		expect(await fs.readFile(source)).toEqual(data);
		expect(await fs.readdir(store.dir)).toEqual([expected.hash]);
		await Bun.write(source, Buffer.alloc(0));
		const empty = await store.importFile(source, { hash: new Bun.SHA256().digest("hex"), bytes: 0 });
		expect((await fs.stat(empty.path)).size).toBe(0);
	});

	it("rejects changed size/hash and canonical conflicts without overwriting data or leaving partial blobs", async () => {
		using tempDir = TempDir.createSync("@omp-blob-upload-");
		const source = path.join(tempDir.path(), "upload.bin");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const data = Buffer.from("intended bytes");
		const expected = { hash: new Bun.SHA256().update(data).digest("hex"), bytes: data.length };
		await Bun.write(source, data);
		await expect(store.importFile(source, { ...expected, bytes: data.length + 1 })).rejects.toThrow("size");
		await expect(store.importFile(source, { ...expected, hash: "../outside" })).rejects.toThrow("identity");
		await expect(store.importFile(source, { ...expected, hash: "0".repeat(64) })).rejects.toThrow("hash");
		expect(await fs.readdir(store.dir)).toEqual([]);
		const corrupted = Buffer.alloc(data.length, 42);
		await Bun.write(path.join(store.dir, expected.hash), corrupted);
		await expect(store.importFile(source, expected)).rejects.toThrow("conflicts");
		expect(await fs.readFile(path.join(store.dir, expected.hash))).toEqual(corrupted);
		expect(await fs.readdir(store.dir)).toEqual([expected.hash]);
	});

	it("cancels between chunks without publishing and rejects linked destinations or non-file sources", async () => {
		using tempDir = TempDir.createSync("@omp-blob-upload-");
		const source = path.join(tempDir.path(), "upload.bin");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const data = Buffer.alloc(BLOB_RANGE_BYTES * 3, 19);
		const expected = { hash: new Bun.SHA256().update(data).digest("hex"), bytes: data.length };
		await Bun.write(source, data);
		const controller = new AbortController();
		let checks = 0;
		const check = controller.signal.throwIfAborted.bind(controller.signal);
		const abort = spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
			if (++checks === 3) controller.abort(new Error("upload cancelled"));
			check();
		});
		try {
			await expect(store.importFile(source, expected, controller.signal)).rejects.toThrow("upload cancelled");
		} finally {
			abort.mockRestore();
		}
		expect(await fs.readdir(store.dir)).toEqual([]);
		expect(await fs.readFile(source)).toEqual(data);
		await expect(store.importFile(tempDir.path(), expected)).rejects.toThrow("unsafe");
		const linked = path.join(tempDir.path(), "linked");
		await fs.symlink(store.dir, linked, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(new BlobStore(linked).importFile(source, expected)).rejects.toThrow("unsafe");
		} finally {
			await fs.unlink(linked);
		}
		expect(await fs.readdir(store.dir)).toEqual([]);
	});
});
