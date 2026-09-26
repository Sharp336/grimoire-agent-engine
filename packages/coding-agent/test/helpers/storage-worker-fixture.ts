import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readStorageBinding, StorageClient } from "../../src/session/storage-client";

/** The worker keeps bodies in `<data>/blobs`; Engine receives this root as ClientHost passes `PI_BLOBS_DIR`. */
export function storageBlobsDir(root: string): string {
	return path.join(root, "storage", "blobs");
}

/** Start an isolated real Rust owner. The caller retains and later disposes its run root. */
export async function startStorageWorker(executable: string, root: string, token: string, boot: number) {
	const tokenFile = path.join(root, "token.txt");
	const readyFile = path.join(root, `ready-${boot}.json`);
	await fs.writeFile(tokenFile, token);
	const child = Bun.spawn(
		[
			executable,
			"--data",
			path.join(root, "storage"),
			"--token-file",
			tokenFile,
			"--ready-file",
			readyFile,
			"--listen",
			"127.0.0.1:0",
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	for (let attempt = 0; attempt < 300; attempt++) {
		try {
			const ready = await Bun.file(readyFile).json();
			const binding = readStorageBinding(
				JSON.stringify({
					url: ready.url,
					token,
					incarnation: ready.incarnation,
					protocolHash: ready.protocolHash,
				}),
			)!;
			const client = new StorageClient(binding);
			return {
				client,
				binding,
				url: ready.url as string,
				token,
				incarnation: ready.incarnation as number,
				async stop() {
					if (child.exitCode === null) child.kill();
					await child.exited;
				},
			};
		} catch (error) {
			if (child.exitCode !== null)
				throw new Error(`Storage worker exited before ready: ${await new Response(child.stderr).text()}`, {
					cause: error,
				});
			await Bun.sleep(50);
		}
	}
	child.kill();
	await child.exited;
	throw new Error("Storage worker readiness timed out");
}
