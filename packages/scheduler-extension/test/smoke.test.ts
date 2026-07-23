import { test } from "bun:test";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";
import { runSmoke } from "./smoke";

// Wraps the standalone behavioral smoke as a bun:test case so `bun test` — and
// repo CI — gates it. `runSmoke()` (a statically imported seam, not a dynamic
// import) sets `PI_CODING_AGENT_DIR` + the cached dir resolver; restoring them in
// `finally` keeps other test files in the same Bun process safe even if a
// scenario throws. The suite's own `node:assert` checks fail the test on error.
test("scheduler-extension behavioral smoke", async () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		await runSmoke();
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		refreshDirsFromEnv();
	}
}, 60_000);
