import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BlobStore } from "../src/session/blob-store";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";

const executable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const runRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;
const cuts = ["intent", "publication_lock", "canonical"] as const;

const exists = (file: string) =>
	fs.stat(file).then(
		() => true,
		() => false,
	);

it.skipIf(!(executable && runRoot))(
	"reclaims ownerless bodies after real writer crashes at every publication cut and after abandon",
	async () => {
		const root = await fs.mkdtemp(path.join(runRoot!, "blob-crash-"));
		console.log(`Blob crash fixture: ${root}`);
		const blobsDir = storageBlobsDir(root);
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
					Bun.sleep(10_000).then(() => {
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
			// The dead producer's intent is the only trace the storage owner needs to recover the hash.
			expect(await fs.readdir(path.join(store.intentsDir, hash))).toHaveLength(1);
			const canonical = path.join(store.liveDir, hash);
			if (cut === "canonical") expect(await fs.readFile(canonical)).toEqual(Buffer.from(body));
			else expect(await exists(canonical)).toBe(false);
			if (cut === "publication_lock") {
				const lock = path.join(store.locksDir, `${hash}.lock`);
				expect(await exists(lock)).toBe(true);
				// A new producer takes over the dead process lock, publishes, then gives the body back.
				const publication = await store.publish(Buffer.from(body), { extension: "png" });
				expect(await exists(lock)).toBe(false);
				expect(await fs.readFile(publication.displayPath)).toEqual(Buffer.from(body));
				await publication.abandon();
			}
		}
		const abandoned = await store.publish(Buffer.from(`abandoned-${crypto.randomUUID()}`), { extension: "png" });
		await abandoned.abandon();
		hashes.push(abandoned.hash);

		const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		const worker = await startStorageWorker(executable!, root, token, 1);
		try {
			let complete = false;
			// The real worker reclaims on its own maintenance clock; the managed tree is the only signal to poll.
			for (let attempt = 0; attempt < 1_200; attempt++) {
				const inventory = await Promise.all([
					fs.readdir(store.intentsDir),
					fs.readdir(store.stagingDir),
					fs.readdir(store.locksDir),
					fs.readdir(store.liveDir),
				]);
				if (inventory.every(items => items.length === 0)) {
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
	120_000,
);
