import { afterEach, beforeEach } from "bun:test";
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

export const storageTestExecutable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
export const storageTestRunRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;
/** Real-owner Engine tests run only when the caller supplies a runtime copy and an existing run root. */
export const storageWorkerUnavailable = !(storageTestExecutable && storageTestRunRoot);

/**
 * Give every test in the enclosing scope its own real Rust owner. Each EngineRuntime the test creates,
 * restarts included, binds to that owner through the ClientHost environment, as `engine serve` does.
 * Tests must dispose their runtimes before they finish.
 */
export function bindTestsToStorageWorker(): { readonly blobsDir: () => string } {
	let root = "";
	let worker: { stop(): Promise<void> } | undefined;
	let saved: { binding?: string; blobs?: string } = {};
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(storageTestRunRoot!, "engine-test-"));
		const started = await startStorageWorker(
			storageTestExecutable!,
			root,
			`${crypto.randomUUID()}${crypto.randomUUID()}`,
			1,
		);
		worker = started;
		saved = { binding: process.env.GRIMOIRE_STORAGE_BINDING, blobs: process.env.PI_BLOBS_DIR };
		process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(started.binding);
		process.env.PI_BLOBS_DIR = storageBlobsDir(root);
	});
	afterEach(async () => {
		await worker?.stop();
		worker = undefined;
		for (const [name, value] of [
			["GRIMOIRE_STORAGE_BINDING", saved.binding],
			["PI_BLOBS_DIR", saved.blobs],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
	});
	return { blobsDir: () => storageBlobsDir(root) };
}
