import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ptreeModuleUrl = pathToFileURL(join(import.meta.dir, "../src/ptree.ts")).href;
const postmortemModuleUrl = pathToFileURL(join(import.meta.dir, "../src/index.ts")).href;

async function runPtreeTimeoutProbe(
	source: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-ptree-timeout-"));
	const probePath = join(root, "probe.ts");
	try {
		await Bun.write(probePath, source);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OMP_AGENT_DIR: join(root, "agent") },
		});
		const watchdog = Bun.sleep(5000).then(() => {
			proc.kill();
			return -999;
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			Promise.race([proc.exited, watchdog]),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("ptree.ChildProcess.attachTimeout()", () => {
	it("contains the watchdog rejection without hiding TimeoutError from callers", async () => {
		const result = await runPtreeTimeoutProbe(`
			import "${postmortemModuleUrl}";
			import { spawn, TimeoutError } from "${ptreeModuleUrl}";

			const child = spawn(["bun", "-e", "setInterval(() => {}, 1_000)"], { timeout: 10 });
			await Bun.sleep(100);

			try {
				await child.exitedCleanly;
				process.stdout.write("NOT_TIMEOUT\\n");
			} catch (err) {
				if (err instanceof TimeoutError) {
					process.stdout.write("TIMEOUT_OK\\n");
				} else {
					process.stdout.write("UNEXPECTED_ERROR\\n");
					throw err;
				}
			}
			await Bun.sleep(0);
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("TIMEOUT_OK");
		expect(result.stderr).not.toContain("[Unhandled Rejection]");
	});
});
