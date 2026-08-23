/**
 * Regression test for issue #7900: `ensureSharedBrowser` retries a start up to
 * three times, and a daemon record that settled `exited`/`failed` is restarted
 * without any stop. On Windows the launcher settles terminal while Chromium
 * keeps running, so every acquisition could leak another browser tree. The
 * launcher pid is discarded at settle time, so the orphans are identified by
 * their `--user-data-dir` profile instead.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	matchesSharedBrowserProfile,
	reapOrphanedSharedBrowsers,
	sharedBrowserDaemonName,
} from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";

const PROFILE = path.resolve("/tmp/omp-runtime/omp.browser.headless.profile");

describe("matchesSharedBrowserProfile", () => {
	it("matches the --user-data-dir=<path> spelling", () => {
		expect(matchesSharedBrowserProfile(["--headless=new", `--user-data-dir=${PROFILE}`], PROFILE)).toBe(true);
	});

	it("matches the separate --user-data-dir <path> spelling", () => {
		expect(matchesSharedBrowserProfile(["--user-data-dir", PROFILE, "--headless=new"], PROFILE)).toBe(true);
	});

	it("normalises a trailing separator", () => {
		expect(matchesSharedBrowserProfile([`--user-data-dir=${PROFILE}${path.sep}`], PROFILE)).toBe(true);
	});

	it("accepts a quoted value", () => {
		expect(matchesSharedBrowserProfile([`--user-data-dir="${PROFILE}"`], PROFILE)).toBe(true);
	});

	it("does not match a different profile directory", () => {
		// The headed and headless daemons share an executable and differ only by
		// profile, so this is what keeps a reap of one from killing the other.
		const headed = PROFILE.replace(sharedBrowserDaemonName(true), sharedBrowserDaemonName(false));
		expect(headed).not.toBe(PROFILE);
		expect(matchesSharedBrowserProfile([`--user-data-dir=${headed}`], PROFILE)).toBe(false);
	});

	it("does not match a user's own Chrome, which passes no profile flag", () => {
		expect(matchesSharedBrowserProfile(["--restore-last-session", "https://example.com"], PROFILE)).toBe(false);
	});

	it("does not match a prefix of the profile path", () => {
		expect(matchesSharedBrowserProfile([`--user-data-dir=${path.dirname(PROFILE)}`], PROFILE)).toBe(false);
	});

	it("ignores a trailing --user-data-dir with no value", () => {
		expect(matchesSharedBrowserProfile(["--headless=new", "--user-data-dir"], PROFILE)).toBe(false);
	});

	it("is false for an empty argv", () => {
		expect(matchesSharedBrowserProfile([], PROFILE)).toBe(false);
	});
});

describe("reapOrphanedSharedBrowsers", () => {
	it("reports nothing reaped when no process runs that executable", () => {
		// Enumeration must stay advisory: an unresolvable executable is a no-op,
		// never a thrown error on the browser-acquisition path.
		const missing = path.join(path.sep, "nonexistent", "omp-test", "chrome-does-not-exist");
		expect(reapOrphanedSharedBrowsers(missing, PROFILE)).toBe(0);
	});

	it("does not throw for an empty executable path", () => {
		expect(reapOrphanedSharedBrowsers("", PROFILE)).toBe(0);
	});
});
