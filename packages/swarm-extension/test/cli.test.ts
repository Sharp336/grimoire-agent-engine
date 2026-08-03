import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cli-test-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("omp-swarm CLI", () => {
	it("exits with code 1 after a failed pipeline", async () => {
		const workspace = path.join(root, "workspace");
		const yamlPath = path.join(root, "swarm.yaml");
		await Bun.write(
			yamlPath,
			`swarm:
  name: cli-failure-test
  workspace: ${workspace}
  mode: pipeline
  agents:
    failing:
      role: deterministic failure probe
      model: invalid-provider/definitely-missing-model
      task: fail before execution
`,
		);

		const cliPath = path.resolve(import.meta.dir, "../src/cli.ts");
		const subprocess = Bun.spawn([process.execPath, cliPath, yamlPath], {
			cwd: path.resolve(import.meta.dir, ".."),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(subprocess.stdout).text();
		const stderr = new Response(subprocess.stderr).text();
		// A real deadline is required here: fake timers cannot detect a child process that keeps Bun's event loop alive.
		const exitCode = await Promise.race([subprocess.exited, Bun.sleep(30_000).then(() => null)]);

		if (exitCode === null) {
			subprocess.kill();
			await subprocess.exited;
		}
		const output = `${await stdout}${await stderr}`;

		expect(exitCode).not.toBeNull();
		expect(exitCode).toBe(1);
		expect(output).toContain("Status: failed");
	}, 40_000);
});
