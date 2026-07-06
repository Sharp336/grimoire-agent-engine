import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as nativesModule from "@oh-my-pi/pi-natives";
import { MacOSAppearance } from "@oh-my-pi/pi-natives";

const originalPlatform = process.platform;
const originalColorfgbg = Bun.env.COLORFGBG;
const originalZellij = Bun.env.ZELLIJ;
const originalThemeDebug = Bun.env.OMP_THEME_DEBUG;
const originalThemeDebugLog = Bun.env.OMP_THEME_DEBUG_LOG;
type ThemeTestGlobals = {
	platform?: NodeJS.Platform;
	colorfgbg?: string;
	zellij?: string;
	themeDebug?: string;
	themeDebugLog?: string;
};

const withThemeTestGlobals = (globals: ThemeTestGlobals = {}) => {
	Object.defineProperty(process, "platform", {
		value: globals.platform ?? "darwin",
		configurable: true,
		writable: true,
	});

	if (globals.colorfgbg === undefined) delete Bun.env.COLORFGBG;
	else Bun.env.COLORFGBG = globals.colorfgbg;

	if (globals.zellij === undefined) delete Bun.env.ZELLIJ;
	else Bun.env.ZELLIJ = globals.zellij;

	if (globals.themeDebug === undefined) delete Bun.env.OMP_THEME_DEBUG;
	else Bun.env.OMP_THEME_DEBUG = globals.themeDebug;

	if (globals.themeDebugLog === undefined) delete Bun.env.OMP_THEME_DEBUG_LOG;
	else Bun.env.OMP_THEME_DEBUG_LOG = globals.themeDebugLog;

	return {
		[Symbol.dispose]() {
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
			if (originalThemeDebug === undefined) delete Bun.env.OMP_THEME_DEBUG;
			else Bun.env.OMP_THEME_DEBUG = originalThemeDebug;
			if (originalThemeDebugLog === undefined) delete Bun.env.OMP_THEME_DEBUG_LOG;
			else Bun.env.OMP_THEME_DEBUG_LOG = originalThemeDebugLog;
			vi.restoreAllMocks();
		},
	};
};

function themeDebugPayloads(stderr: string[], event: string): Record<string, unknown>[] {
	const prefix = `[omp-theme-debug] theme ${event} `;
	return stderr
		.join("")
		.split("\n")
		.filter(line => line.startsWith(prefix))
		.map(line => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
}

describe("theme auto-detection", () => {
	beforeEach(async () => {
		themeModule.stopThemeWatcher();
		const darkTheme = await themeModule.getThemeByName("dark");
		if (!darkTheme) {
			throw new Error("Failed to load dark theme for tests");
		}
		themeModule.setThemeInstance(darkTheme);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("prefers COLORFGBG before macOS fallback inside Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1", colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("keeps honoring terminal-reported appearance outside fallback mode", async () => {
		using _globals = withThemeTestGlobals();
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const observerSpy = vi.spyOn(nativesModule.MacAppearanceObserver, "start");

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(true, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
		expect(observerSpy).not.toHaveBeenCalled();
	});

	it("updates auto theme from the native fallback observer in Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1" });
		const stop = vi.fn();
		let onAppearanceChange: ((appearance: "dark" | "light") => void) | undefined;
		vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const observerSpy = vi.spyOn(nativesModule.MacAppearanceObserver, "start").mockImplementation(((
			callback: (err: null | Error, appearance: "dark" | "light") => void,
		) => {
			onAppearanceChange = (appearance: "dark" | "light") => callback(null, appearance);
			return { stop };
		}) as any);

		await themeModule.initTheme(true, undefined, undefined, "dark", "light");

		expect(observerSpy).toHaveBeenCalledTimes(1);
		expect(themeModule.getCurrentThemeName()).toBe("light");
		expect(onAppearanceChange).toBeDefined();

		onAppearanceChange!("dark");
		await Bun.sleep(0);

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		themeModule.stopThemeWatcher();
		expect(stop).toHaveBeenCalledTimes(1);
	});
	it("Zellij fallback stays macOS-only (Linux + Zellij = honor terminal)", async () => {
		using _globals = withThemeTestGlobals({ platform: "linux", zellij: "1" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("terminal-reported appearance wins over conflicting COLORFGBG", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("light");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("persists OSC 11 source and selected light theme in debug log", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-theme-debug-"));
		const logPath = path.join(tempDir, "theme.log");

		try {
			using _globals = withThemeTestGlobals({ colorfgbg: "15;0", themeDebug: "1", themeDebugLog: logPath });
			const stderr: string[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
				stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			});
			const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Dark);

			themeModule.onTerminalAppearanceChange("light");
			await themeModule.initTheme(false, undefined, undefined, "dark", "light");

			expect(themeModule.getCurrentThemeName()).toBe("light");
			expect(detectSpy).not.toHaveBeenCalled();
			expect(themeDebugPayloads(stderr, "selected-signal")).toContainEqual(
				expect.objectContaining({ source: "osc11", appearance: "light" }),
			);
			expect(themeDebugPayloads(stderr, "selected-theme")).toContainEqual(
				expect.objectContaining({ appearance: "light", theme: "light" }),
			);

			const log = fs.readFileSync(logPath, "utf8");
			expect(log).toContain("[omp-theme-debug] theme selected-signal");
			expect(log).toContain('"source":"osc11"');
			expect(log).toContain('"appearance":"light"');
			expect(log).toContain("[omp-theme-debug] theme selected-theme");
			expect(log).toContain('"theme":"light"');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
