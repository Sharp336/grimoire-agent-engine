import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const originalPlatform = process.platform;
const originalZellij = Bun.env.ZELLIJ;
const originalColorfgbg = Bun.env.COLORFGBG;

describe("theme auto-detection", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
		delete Bun.env.COLORFGBG;
		delete Bun.env.ZELLIJ;
		vi.restoreAllMocks();
	});

	afterEach(() => {
		themeModule.stopThemeWatcher();
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			configurable: true,
			writable: true,
		});
		if (originalColorfgbg === undefined) delete Bun.env.COLORFGBG;
		else Bun.env.COLORFGBG = originalColorfgbg;
		if (originalZellij === undefined) delete Bun.env.ZELLIJ;
		else Bun.env.ZELLIJ = originalZellij;
		vi.restoreAllMocks();
	});

	it("falls back past a bogus dark OSC 11 report inside Zellij on macOS", async () => {
		Bun.env.ZELLIJ = "1";
		const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 1,
			stdout: Buffer.from(""),
			stderr: Buffer.from(""),
		} as ReturnType<typeof Bun.spawnSync>);

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("light");
		expect(spawnSync).toHaveBeenCalledWith(["defaults", "read", "-g", "AppleInterfaceStyle"]);
	});

	it("keeps honoring terminal-reported appearance outside Zellij", async () => {
		const spawnSync = vi.spyOn(Bun, "spawnSync");

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(spawnSync).not.toHaveBeenCalled();
	});
});
