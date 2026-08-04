import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("profile .env isolation", () => {
	test("cli.ts static import graph must not apply the default-profile .env at module load", async () => {
		// The CLI supports --profile and OMP_PROFILE: setProfile() must run BEFORE
		// anything applies an agent `.env`. `@oh-my-pi/pi-utils/env` does exactly
		// that at module load, so nothing in cli.ts's static import graph may
		// reach it — otherwise the default profile's `.env` leaks into every
		// `--profile` invocation and the selected profile's `.env` never applies.
		const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-env-"));
		const probe = path.join(tempHome, "probe.ts");
		try {
			const agentDir = path.join(tempHome, ".omp", "agent");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(path.join(agentDir, ".env"), "OMP_SENTINEL=leaked\n");

			// Probe imports the real entry module. cli.ts does not launch itself
			// because the probe script (not cli.ts) is the process entry — this
			// exercises exactly the module-load graph a real `omp --profile x`
			// startup sees before runCli() runs.
			const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
			await fs.writeFile(
				probe,
				`import ${JSON.stringify(cliPath)};\nprocess.stdout.write(process.env.OMP_SENTINEL === "leaked" ? "LEAKED" : "CLEAN");\n`,
			);

			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) env[key] = value;
			}
			env.HOME = tempHome;
			delete env.OMP_SENTINEL;
			delete env.OMP_PROFILE;
			delete env.PI_PROFILE;

			const result = Bun.spawnSync([process.execPath, probe], {
				cwd: path.join(import.meta.dir, ".."),
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = result.stdout.toString().trim();
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			expect(output).toBe("CLEAN");
		} finally {
			await fs.rm(tempHome, { recursive: true, force: true });
		}
	}, 60_000);
});
