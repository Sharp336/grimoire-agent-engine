import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BlobStore } from "../src/session/blob-store";
import { startStorageWorker } from "./helpers/storage-worker-fixture";

const executable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const runRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;
const cuts = ["intent", "publication_lock", "canonical", "complete"] as const;

it.skipIf(!(executable && runRoot))(
	"recovers real writer crashes at every blob publication cut",
	async () => {
		const root = await fs.mkdtemp(path.join(runRoot!, "blob-crash-"));
		console.log(`Blob crash fixture: ${root}`);
		const blobsDir = path.join(root, "blobs");
		const store = new BlobStore(blobsDir);
		const hashes: string[] = [];
		for (const cut of cuts) {
			const body = `crash-${cut}-${crypto.randomUUID()}`;
			const hash = new Bun.SHA256().update(body).digest("hex");
			hashes.push(hash);
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "helpers", "blob-publication-crash-writer.ts"),
					blobsDir,
					cut,
					body,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			try {
				const reader = child.stdout.getReader();
				const entered = await Promise.race([
					reader.read(),
					Bun.sleep(5_000).then(() => {
						throw new Error(`Writer did not reach ${cut}`);
					}),
				]);
				expect(entered.done).toBe(false);
				expect(new TextDecoder().decode(entered.value).trim()).toBe(`${cut} ${hash}`);
				reader.releaseLock();
			} finally {
				if (child.exitCode === null) child.kill();
				await child.exited;
			}
			const intentDir = path.join(blobsDir, ".managed", "intents", hash);
			expect((await fs.readdir(intentDir)).length).toBe(1);
			const canonical = path.join(store.liveDir, hash);
			if (cut === "intent" || cut === "publication_lock") {
				expect(
					await fs.stat(canonical).then(
						() => true,
						() => false,
					),
				).toBe(false);
			} else {
				expect(await fs.readFile(canonical)).toEqual(Buffer.from(body));
			}
			if (cut === "publication_lock") {
				const lock = path.join(store.locksDir, `${hash}.lock`);
				expect(
					await fs.stat(lock).then(
						() => true,
						() => false,
					),
				).toBe(true);
				// A new writer must take over the exact dead process lock and publish immutable bytes.
				expect(store.putSync(Buffer.from(body), { extension: "png" }).hash).toBe(hash);
				expect(
					await fs.stat(lock).then(
						() => true,
						() => false,
					),
				).toBe(false);
			}
			if (cut === "complete") {
				expect((await fs.readdir(store.completedDir)).length).toBeGreaterThan(0);
			}
			for (const file of [canonical, `${canonical}.png`]) {
				await fs.utimes(file, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000)).catch(error => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		}
		const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		const worker = await startStorageWorker(executable!, root, token, 1);
		try {
			let complete = false;
			for (let attempt = 0; attempt < 1_200; attempt++) {
				const inventory = await Promise.all([
					fs.readdir(store.intentsDir),
					fs.readdir(store.stagingDir),
					fs.readdir(store.completedDir),
					fs.readdir(store.locksDir),
				]);
				if (
					inventory.every(items => items.length === 0) &&
					hashes.every(hash => !Bun.file(path.join(store.liveDir, hash)).size)
				) {
					complete = true;
					break;
				}
				await Bun.sleep(50);
			}
			if (!complete) {
				const status = await fetch(`${worker.url}/v1/reclaim/status`, {
					headers: { Authorization: `Bearer ${worker.token}` },
				}).then(response => response.json());
				const remaining = await fs.readdir(store.liveDir);
				throw new Error(`Blob recovery did not finish: ${JSON.stringify({ status, remaining })}`);
			}
			for (const hash of hashes) expect(await store.get(hash)).toBeNull();
		} finally {
			await worker.stop();
		}
	},
	90_000,
);
