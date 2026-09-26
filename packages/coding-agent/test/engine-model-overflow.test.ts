import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

it("never records an aborted native model stream as a completed effect or retries it", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "artel-s3-model-overflow-"));
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/engine-model-overflow.ts"), root], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GRIMOIRE_STORAGE_BINDING: undefined },
	});
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
		await fs.rm(root, { recursive: true });
	}
}, 30_000);
