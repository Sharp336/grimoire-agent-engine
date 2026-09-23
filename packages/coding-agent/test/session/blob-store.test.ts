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
	it("publishes synchronously without replacing an existing canonical body", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-sync-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("accepted image bytes");
		const first = store.putSync(data, { extension: "png" });
		const before = await fs.stat(first.path);
		const repeated = store.putSync(data, { extension: "png" });
		expect(repeated.path).toBe(first.path);
		expect((await fs.stat(first.path)).ino).toBe(before.ino);
		expect(await fs.readFile(first.displayPath)).toEqual(data);
		const conflict = Buffer.alloc(data.length, 7);
		await fs.writeFile(first.path, conflict);
		expect(() => store.putSync(data)).toThrow("conflicts");
		expect(await fs.readFile(first.path)).toEqual(conflict);
	});

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
		expect(await Bun.file(path.join(store.liveDir, `${hash}.webp`)).bytes()).toEqual(new Uint8Array(data));
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
		expect(await fs.readdir(store.liveDir)).toEqual([expected.hash]);
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
		expect(await fs.readdir(store.liveDir).catch(() => [])).toEqual([]);
		const corrupted = Buffer.alloc(data.length, 42);
		await fs.mkdir(store.liveDir, { recursive: true });
		await Bun.write(path.join(store.liveDir, expected.hash), corrupted);
		await expect(store.importFile(source, expected)).rejects.toThrow("conflicts");
		expect(await fs.readFile(path.join(store.liveDir, expected.hash))).toEqual(corrupted);
		expect(await fs.readdir(store.liveDir)).toEqual([expected.hash]);
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
		expect(await fs.readdir(store.liveDir).catch(() => [])).toEqual([]);
		expect(await fs.readFile(source)).toEqual(data);
		await expect(store.importFile(tempDir.path(), expected)).rejects.toThrow("unsafe");
		const linked = path.join(tempDir.path(), "linked");
		await fs.symlink(store.dir, linked, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(new BlobStore(linked).importFile(source, expected)).rejects.toThrow("unsafe");
		} finally {
			await fs.unlink(linked);
		}
		expect(await fs.readdir(store.liveDir).catch(() => [])).toEqual([]);
	});
});

describe("BlobStore async publication responsiveness", () => {
	it("keeps control timers moving while another process holds the hash lock", async () => {
		using tempDir = TempDir.createSync("artel-s5-r4-lock-");
		const data = Buffer.from("publication waits without blocking other chats");
		const hash = new Bun.SHA256().update(data).digest("hex");
		const ready = path.join(tempDir.path(), "holder-ready");
		const release = path.join(tempDir.path(), "holder-release");
		const entered = Promise.withResolvers<void>();
		const secondWait = Promise.withResolvers<void>();
		const store = new BlobStore(path.join(tempDir.path(), "blobs"), stage => {
			if (stage === "lock_wait") entered.resolve();
		});
		const cancelStore = new BlobStore(store.dir, stage => {
			if (stage === "lock_wait") secondWait.resolve();
		});
		const lock = path.join(store.locksDir, `${hash}.lock`);
		const holder = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "../helpers/blob-publication-lock-holder.ts"),
				lock,
				ready,
				release,
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		try {
			for (let attempt = 0; attempt < 500; attempt++) {
				if (
					await fs.stat(ready).then(
						() => true,
						() => false,
					)
				)
					break;
				await Bun.sleep(10);
			}
			expect(
				await fs.stat(ready).then(
					() => true,
					() => false,
				),
			).toBe(true);
			let settled = false;
			const publishing = store.put(data).finally(() => {
				settled = true;
			});
			void publishing.catch(() => {});
			await Promise.race([
				entered.promise,
				Bun.sleep(5_000).then(() => {
					throw new Error("async publication never reached lock wait");
				}),
			]);
			const controlTick = Promise.withResolvers<void>();
			setTimeout(controlTick.resolve, 0);
			await controlTick.promise;
			expect(settled).toBe(false);
			const abort = new AbortController();
			const cancelled = cancelStore.put(data, undefined, abort.signal);
			await Promise.race([
				secondWait.promise,
				Bun.sleep(5_000).then(() => {
					throw new Error("abort case never reached lock wait");
				}),
			]);
			abort.abort(new Error("publication cancelled"));
			await expect(cancelled).rejects.toThrow("publication cancelled");
			expect(
				await fs.stat(path.join(store.liveDir, hash)).then(
					() => true,
					() => false,
				),
			).toBe(false);
			await fs.writeFile(release, "");
			expect(await holder.exited).toBe(0);
			const result = await publishing;
			expect(result.hash).toBe(hash);
			expect(await fs.readFile(result.path)).toEqual(data);
		} finally {
			await fs.writeFile(release, "");
			await holder.exited;
		}
	}, 15_000);

	it("yields during an existing body comparison and retains exact bytes", async () => {
		using tempDir = TempDir.createSync("artel-s5-r4-compare-");
		const data = Buffer.alloc(BLOB_RANGE_BYTES * 2 + 17, 41);
		const hash = new Bun.SHA256().update(data).digest("hex");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pause = false;
		const store = new BlobStore(path.join(tempDir.path(), "blobs"), stage => {
			if (stage === "compare" && pause) {
				entered.resolve();
				return release.promise;
			}
		});
		await store.put(data);
		pause = true;
		let settled = false;
		const duplicate = store.restore(hash, data).finally(() => {
			settled = true;
		});
		void duplicate.catch(() => {});
		try {
			await Promise.race([
				entered.promise,
				Bun.sleep(5_000).then(() => {
					throw new Error("existing body comparison was not reached");
				}),
			]);
			const controlTick = Promise.withResolvers<void>();
			setTimeout(controlTick.resolve, 0);
			await controlTick.promise;
			expect(settled).toBe(false);
		} finally {
			release.resolve();
		}
		await duplicate;
		expect(await fs.readFile(path.join(store.liveDir, hash))).toEqual(data);
	}, 15_000);

	it("fails a bounded lock wait without publishing a missing body", async () => {
		using tempDir = TempDir.createSync("artel-s5-r4-deadline-");
		const data = Buffer.from("lock timeout must not claim publication");
		const hash = new Bun.SHA256().update(data).digest("hex");
		const ready = path.join(tempDir.path(), "holder-ready");
		const release = path.join(tempDir.path(), "holder-release");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const lock = path.join(store.locksDir, `${hash}.lock`);
		const holder = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "../helpers/blob-publication-lock-holder.ts"),
				lock,
				ready,
				release,
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		try {
			for (let attempt = 0; attempt < 500; attempt++) {
				if (
					await fs.stat(ready).then(
						() => true,
						() => false,
					)
				)
					break;
				await Bun.sleep(10);
			}
			expect(
				await fs.stat(ready).then(
					() => true,
					() => false,
				),
			).toBe(true);
			await expect(store.put(data)).rejects.toThrow("Blob publication lock is busy");
			expect(
				await fs.stat(path.join(store.liveDir, hash)).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.writeFile(release, "");
			await holder.exited;
		}
	}, 15_000);
});
