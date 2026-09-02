import { afterEach, expect, it, vi } from "bun:test";
import { loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

afterEach(() => vi.restoreAllMocks());

it("loads Puppeteer without mutating process cwd", async () => {
	const cwd = process.cwd();
	const chdir = vi.spyOn(process, "chdir");
	await Promise.all([loadPuppeteer(), loadPuppeteer()]);
	expect(chdir).not.toHaveBeenCalled();
	expect(process.cwd()).toBe(cwd);
});
