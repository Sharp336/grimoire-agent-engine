import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";

const executable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const runRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;

it.skipIf(!(executable && runRoot))(
	"never records an aborted native model stream as a completed effect or retries it",
	async () => {
		const root = await fs.mkdtemp(path.join(runRoot!, "model-overflow-"));
		const worker = await startStorageWorker(executable!, root, `${crypto.randomUUID()}${crypto.randomUUID()}`, 1);
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/engine-model-overflow.ts"), root],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GRIMOIRE_STORAGE_BINDING: JSON.stringify(worker.binding),
					PI_BLOBS_DIR: storageBlobsDir(root),
				},
			},
		);
		try {
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			// No unhandled rejection may escape a capacity overflow: the child exits cleanly.
			expect({ code, stderr }).toMatchObject({ code: 0 });
			expect(stderr).not.toContain("AssertionError");
			expect(stdout).toContain('"modelOutcome":"failed"');
			expect(stdout).toContain('"calls":1');
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await worker.stop();
			await fs.rm(root, { recursive: true });
		}
	},
	90_000,
);
