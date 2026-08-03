import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isExecutableFileForTest,
	stealthIgnoreDefaultArgsForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

const AUTOMATION_FLAG = "--enable-automation";

const EDGE_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge-stable",
] as const;

const CHROME_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
] as const;

describe("browser launch stealth defaults", () => {
	it("keeps Puppeteer's automation default for Microsoft Edge executables", () => {
		for (const executablePath of EDGE_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).not.toContain(AUTOMATION_FLAG);
			expect(ignoreDefaultArgs).toContain("--disable-extensions");
		}
	});

	it("continues filtering Puppeteer's automation default for Chrome and Chromium executables", () => {
		for (const executablePath of CHROME_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).toContain(AUTOMATION_FLAG);
		}
	});
});

describe("system Chromium executable-file predicate", () => {
	it("rejects a non-executable regular file on POSIX", () => {
		if (process.platform === "win32") return;

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-chrome-noexec-"));
		const candidate = path.join(dir, "fake-chrome");
		fs.writeFileSync(candidate, "#!/bin/sh\n");
		fs.chmodSync(candidate, 0o644);

		try {
			expect(isExecutableFileForTest(candidate)).toBe(false);

			fs.chmodSync(candidate, 0o755);
			expect(isExecutableFileForTest(candidate)).toBe(true);
		} finally {
			// Restore permissions so cleanup can remove the file on restrictive umasks.
			try {
				fs.chmodSync(candidate, 0o644);
			} catch {
				// ignore restore failures during cleanup
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
