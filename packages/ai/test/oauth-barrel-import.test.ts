import { describe, expect, it } from "bun:test";

const STATIC_IMPORT_FIXTURE = `${import.meta.dir}/fixtures/oauth-barrel-import.ts`;

describe("OAuth barrel imports", () => {
	it("loads with the Anthropic provider and auth storage while preserving public exports", async () => {
		const child = Bun.spawn([process.execPath, STATIC_IMPORT_FIXTURE], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

		expect(exitCode, stderr).toBe(0);
		// The fixture subprocess transpiles the whole package barrel (plus the
		// anthropic provider and auth storage) from a cold cache: ~2.8s on a warm
		// developer box for the first run, and past the 5s default on a CI runner,
		// where every job starts cold. The failure surfaces as a killed dangling
		// process rather than a non-zero exit, since the child is still linking.
	}, 60_000);
});
