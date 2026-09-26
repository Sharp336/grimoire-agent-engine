import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BLOB_RANGE_BYTES,
	BlobSourceMismatchError,
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
		expect(await Bun.file(path.join(store.dir, `${hash}.webp`)).bytes()).toEqual(new Uint8Array(data));
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

describe("BlobStore managed publication", () => {
	const sha256 = (data: Buffer) => new Bun.SHA256().update(data).digest("hex");
	const intents = (store: BlobStore, hash: string) =>
		fs.readdir(path.join(store.intentsDir, hash)).catch(() => [] as string[]);

	it("pins the live body with one intent per publication until it is released or abandoned", async () => {
		using tempDir = TempDir.createSync("@omp-blob-publish-");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const data = Buffer.from("managed image bytes");
		const first = await store.publish(data, { extension: "png" });
		expect(first.path).toBe(path.join(store.liveDir, first.hash));
		expect(first.displayPath).toBe(`${first.path}.png`);
		expect((await fs.stat(first.displayPath)).ino).toBe((await fs.stat(first.path)).ino);
		expect(await intents(store, first.hash)).toEqual([
			expect.stringMatching(new RegExp(`^${process.pid}\\.\\d+\\.[0-9a-f-]{36}$`)),
		]);
		// Reuse of the live body; a type outside the fixed image set gets no sidecar the owner would miss.
		const second = await store.publish(data, { extension: "bmp" });
		expect(second.displayPath).toBe(second.path);
		expect(await intents(store, first.hash)).toHaveLength(2);
		await first.release();
		await first.abandon();
		await second.abandon();
		expect(await intents(store, first.hash)).toEqual([expect.stringMatching(/\.abandoned$/)]);
		expect(await fs.readdir(store.stagingDir)).toEqual([]);
		expect(await fs.readdir(store.locksDir)).toEqual([]);
		expect((await fs.readdir(store.liveDir)).sort()).toEqual([first.hash, `${first.hash}.png`]);
		expect(await fs.readdir(store.dir)).toEqual([".managed"]);
	});

	it("links a verified upload file instead of copying it and abandons a torn one", async () => {
		using tempDir = TempDir.createSync("@omp-blob-publish-file-");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const source = path.join(tempDir.path(), "payload.bin");
		const data = Buffer.from(Array.from({ length: BLOB_RANGE_BYTES * 3 + 17 }, (_, index) => index % 251));
		await Bun.write(source, data);
		const published = await store.publish({ file: source, hash: sha256(data), bytes: data.length });
		expect((await fs.stat(published.path)).ino).toBe((await fs.stat(source)).ino);
		await published.release();

		const declared = Buffer.alloc(100, 3);
		const torn = path.join(tempDir.path(), "torn.bin");
		await Bun.write(torn, Buffer.concat([declared.subarray(0, 60), Buffer.alloc(40)]));
		for (const bytes of [declared.length, declared.length + 1])
			await expect(store.publish({ file: torn, hash: sha256(declared), bytes })).rejects.toBeInstanceOf(
				BlobSourceMismatchError,
			);
		await expect(store.publish({ file: torn, hash: "../outside", bytes: 100 })).rejects.toThrow("identity");
		expect(await fs.readdir(store.liveDir)).toEqual([published.hash]);
		expect(await fs.readdir(store.stagingDir)).toEqual([]);
		expect(await intents(store, sha256(declared))).toEqual([
			expect.stringMatching(/\.abandoned$/),
			expect.stringMatching(/\.abandoned$/),
		]);

		const corrupted = Buffer.alloc(99, 42);
		await Bun.write(path.join(store.liveDir, sha256(declared)), corrupted);
		await expect(store.publish(declared)).rejects.toThrow("conflicts");
		expect(await fs.readFile(path.join(store.liveDir, sha256(declared)))).toEqual(corrupted);
	});

	it("cancels while hashing without publishing and refuses a linked root", async () => {
		using tempDir = TempDir.createSync("@omp-blob-publish-cancel-");
		const source = path.join(tempDir.path(), "payload.bin");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const data = Buffer.alloc(BLOB_RANGE_BYTES * 3, 19);
		await Bun.write(source, data);
		const controller = new AbortController();
		let checks = 0;
		const check = controller.signal.throwIfAborted.bind(controller.signal);
		const abort = spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
			if (++checks === 3) controller.abort(new Error("upload cancelled"));
			check();
		});
		try {
			await expect(
				store.publish({ file: source, hash: sha256(data), bytes: data.length }, { signal: controller.signal }),
			).rejects.toThrow("upload cancelled");
		} finally {
			abort.mockRestore();
		}
		expect(await fs.readdir(store.liveDir)).toEqual([]);
		expect(await fs.readdir(store.stagingDir)).toEqual([]);
		expect(await fs.readFile(source)).toEqual(data);
		const linked = path.join(tempDir.path(), "linked");
		await fs.symlink(store.dir, linked, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(new BlobStore(linked).publish(data)).rejects.toThrow("unsafe");
		} finally {
			await fs.unlink(linked);
		}
	});

	it("takes over a dead producer's lock through its break gate", async () => {
		using tempDir = TempDir.createSync("@omp-blob-publish-stale-");
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const data = Buffer.from("published after a crashed producer");
		const dead = Bun.spawn([process.execPath, "-e", ""]);
		await dead.exited;
		const lock = path.join(store.locksDir, `${sha256(data)}.lock`);
		await fs.mkdir(store.locksDir, { recursive: true });
		await fs.writeFile(lock, `${dead.pid}\n0\n`);
		const published = await store.publish(data);
		expect(await fs.readFile(published.path)).toEqual(data);
		expect(await fs.readdir(store.locksDir)).toEqual([]);
		await published.release();
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
			const publishing = store.publish(data).finally(() => {
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
			const cancelled = cancelStore.publish(data, { signal: abort.signal });
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
			await expect(store.publish(data)).rejects.toThrow("Blob publication lock is busy");
			expect(
				await fs.stat(path.join(store.liveDir, hash)).then(
					() => true,
					() => false,
				),
			).toBe(false);
			// The failed producer hands the hash back to the storage owner instead of pinning it.
			expect(await fs.readdir(path.join(store.intentsDir, hash))).toEqual([expect.stringMatching(/\.abandoned$/)]);
			expect(await fs.readdir(store.stagingDir)).toEqual([]);
		} finally {
			await fs.writeFile(release, "");
			await holder.exited;
		}
	}, 15_000);
});
