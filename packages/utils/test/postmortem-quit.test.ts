import { describe, expect, it } from "bun:test";
import * as postmortem from "../src/postmortem";

const childFlag = "--quit-without-drain-child";

if (process.argv.includes(childFlag)) {
	Object.defineProperty(process.stdout, "writableLength", { value: 1, configurable: true });
	await postmortem.quit(23, { drainStdout: false });
}

describe("postmortem quit", () => {
	it("exits without waiting for pending stdout when draining is disabled", async () => {
		const child = Bun.spawn([process.execPath, import.meta.path, childFlag], {
			stdout: "pipe",
			stderr: "pipe",
		});
		// The draining path caps out at Bun.sleep(5000), so any budget under 5s still
		// proves the drain was skipped. 500ms did not cover the child's cold start and
		// module graph load, so CI intermittently observed "timeout" instead of exit 23.
		const timeout = Bun.sleep(2500).then(() => "timeout" as const);
		try {
			expect(await Promise.race([child.exited, timeout])).toBe(23);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
