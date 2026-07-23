import { expect, test } from "bun:test";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";

// Wraps the standalone behavioral smoke (a top-level `node:assert` script) as a
// bun:test case so `bun test` — and repo CI — gates it. The suite runs as a side
// effect of loading `./smoke`, which mutates `PI_CODING_AGENT_DIR` + the cached
// dir resolver; capturing and restoring those in this `finally` keeps later test
// files in the same Bun process safe even when a scenario throws.
test("scheduler-extension behavioral smoke", async () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		// ts-no-dynamic-import exception: a static `import` is hoisted and would run
		// the env-mutating suite BEFORE this try, so it could not be wrapped in the
		// finally that restores global state on a failing scenario. Loading it here
		// is precisely the module-load boundary the rule carves out.
		const mod = await import("./smoke");
		expect(mod.smokeCompleted).toBe(true);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		refreshDirsFromEnv();
	}
}, 60_000);
