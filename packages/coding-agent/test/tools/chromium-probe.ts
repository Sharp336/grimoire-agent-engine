import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

/**
 * Whether the Chromium puppeteer resolves can actually execute on this host.
 * CI runners without Chrome's system libraries (libnspr4 & co.) hold the
 * downloaded binary but cannot exec it — probe with --version and skip
 * instead of failing.
 */
async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		const probe = Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" });
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Gate for tests that launch a real Chromium. Exported as a function, NOT an
 * awaited value binding: a cross-module top-level-await export is read from
 * its temporal dead zone by importers that consume it synchronously at module
 * scope (test.skipIf/describe.skipIf), crashing bun with "Cannot access before
 * initialization" regardless of how fast the probe resolves. Consumers do
 * `const CHROMIUM_AVAILABLE = await isChromiumAvailable()` in their own module
 * body, where same-module top-level await is guaranteed to complete first.
 */
export async function isChromiumAvailable(): Promise<boolean> {
	return chromiumCanLaunch();
}
