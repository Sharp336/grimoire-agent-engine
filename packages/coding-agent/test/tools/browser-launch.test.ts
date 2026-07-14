import { describe, expect, it } from "bun:test";
import {
	buildBrowserLaunchConfig,
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

describe("browser launch platform safety", () => {
	it("moves only the Windows headless fallback window off-screen", () => {
		const windowsHeadless = buildBrowserLaunchConfig({ headless: true }, "win32");
		const windowsVisible = buildBrowserLaunchConfig({ headless: false }, "win32");
		const linuxHeadless = buildBrowserLaunchConfig({ headless: true }, "linux");

		expect(windowsHeadless.launchArgs).toContain("--window-position=-10000,-10000");
		expect(windowsVisible.launchArgs).not.toContain("--window-position=-10000,-10000");
		expect(linuxHeadless.launchArgs).not.toContain("--window-position=-10000,-10000");
	});
});
