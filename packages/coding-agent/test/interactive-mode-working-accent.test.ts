import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionColor from "@oh-my-pi/pi-coding-agent/utils/session-color";
import type { Container, NativeScrollbackLiveRegion } from "@oh-my-pi/pi-tui";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	sessionManager: SessionManager;
	tempDir: TempDir;
};

let harnesses: Harness[] = [];

function defined<T>(value: T | undefined): T {
	expect(value).toBeDefined();
	return value as T;
}

async function createHarness(sessionName: string): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-working-accent-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName(sessionName, "user");
	const session = {
		sessionManager,
		settings,
		agent: {
			state: { tools: [] },
			metadataForProvider: () => undefined,
		},
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	const harness = { mode, sessionManager, tempDir };
	harnesses.push(harness);
	return harness;
}

async function createIsolatedHarness(sessionName: string) {
	const tempDir = TempDir.createSync("@pi-isolated-cwd-");
	const isolatedSettings = await Settings.loadIsolated({
		cwd: tempDir.path(),
		agentDir: path.join(tempDir.path(), "agent"),
	});
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName(sessionName, "user");
	const refreshLcmSettingsAndRebind = vi.fn(async () => {});
	const session = {
		sessionManager,
		settings: isolatedSettings,
		agent: {
			state: { tools: [] },
			metadataForProvider: () => undefined,
		},
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		refreshLcmSettingsAndRebind,
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	resetSettingsForTest();
	const harness = { mode, sessionManager, tempDir };
	harnesses.push(harness);
	return { ...harness, isolatedSettings, refreshLcmSettingsAndRebind };
}

function startStableLoader(mode: InteractiveMode): void {
	mode.ensureLoadingAnimation();
	mode.loadingAnimation?.stop();
}

function renderLoader(mode: InteractiveMode): string {
	return mode.statusContainer.render(120).join("\n");
}

function shadowAccentSurfaceLuminance(value: number | undefined): () => void {
	Object.defineProperty(theme, "accentSurfaceLuminance", {
		configurable: true,
		get: () => value,
	});
	return () => {
		delete (theme as unknown as { accentSurfaceLuminance?: number }).accentSurfaceLuminance;
	};
}

afterEach(() => {
	for (const harness of harnesses) {
		harness.mode.stop();
		harness.tempDir.removeSync();
	}
	harnesses = [];
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("InteractiveMode working-message session accent cache", () => {
	it("reports a live seam only while status content is mounted", async () => {
		const { mode } = await createHarness("Live status");
		const statusContainer = mode.statusContainer as Container & NativeScrollbackLiveRegion;

		// Empty: no seam — the engine may commit freely past the container.
		expect(statusContainer.getNativeScrollbackLiveRegionStart()).toBeUndefined();
		// Loader mounted: every row is live, so the seam sits at 0 and keeps
		// the animating loader out of immutable native scrollback.
		startStableLoader(mode);
		expect(statusContainer.getNativeScrollbackLiveRegionStart()).toBe(0);
	});

	it("reuses one computed accent across loader spinner and message colorizers", async () => {
		const { mode } = await createHarness("Cached session");
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");
		const getAnsi = vi.spyOn(sessionColor, "getSessionAccentAnsi");

		// Colorizers run lazily at render time (loader layout cache); the accent
		// computation is observable only after a render.
		startStableLoader(mode);
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);

		mode.loadingAnimation?.setMessage("Still working");
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);
	});

	it("recomputes for session renames and keeps the main ANSI path status-line equivalent", async () => {
		const initialName = "Alpha session";
		const renamedName = "Beta session";
		const { mode, sessionManager } = await createHarness(initialName);
		const initialAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					initialName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const renamedAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					renamedName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(initialAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		await sessionManager.setSessionName(renamedName, "user");
		mode.loadingAnimation?.setMessage("Renamed session");
		expect(renderLoader(mode)).toContain(renamedAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});

	it("keys cached accents by theme accent-surface luminance", async () => {
		const sessionName = "Luminance session";
		const { mode } = await createHarness(sessionName);
		const restoreInitial = shadowAccentSurfaceLuminance(undefined);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		try {
			startStableLoader(mode);
			renderLoader(mode);
			expect(getHex).toHaveBeenCalledTimes(1);
			expect(getHex.mock.calls[0]).toEqual([sessionName, theme.getMajorThemeColorHexes(), undefined]);

			restoreInitial();
			const restoreLight = shadowAccentSurfaceLuminance(0.72);
			try {
				mode.loadingAnimation?.setMessage("Light theme");
				renderLoader(mode);
				expect(getHex).toHaveBeenCalledTimes(2);
				expect(getHex.mock.calls[1]).toEqual([sessionName, theme.getMajorThemeColorHexes(), 0.72]);
			} finally {
				restoreLight();
			}
		} finally {
			restoreInitial();
		}
	});

	it("caches disabled session accents and recomputes when the setting is enabled again", async () => {
		const sessionName = "Toggle session";
		const { mode } = await createHarness(sessionName);
		const accentAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					sessionName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", false);
		mode.loadingAnimation?.setMessage("Accent disabled");
		expect(renderLoader(mode)).not.toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", true);
		mode.loadingAnimation?.setMessage("Accent enabled");
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});
});

describe("InteractiveMode isolated cwd settings", () => {
	it("reloads the destination settings and rebinds LCM without a global Settings singleton", async () => {
		const { mode, tempDir, isolatedSettings, refreshLcmSettingsAndRebind } =
			await createIsolatedHarness("Isolated move");
		const targetDir = path.join(tempDir.path(), "destination");
		fs.mkdirSync(path.join(targetDir, ".omp"), { recursive: true });
		await Bun.write(
			path.join(targetDir, ".omp", "config.yml"),
			"context:\n  engine: lossless\n  lossless:\n    maxConcurrentSummaries: 2\n",
		);
		vi.spyOn(mode, "refreshTitleSystemPrompt").mockResolvedValue(undefined);
		vi.spyOn(mode, "refreshSkillState").mockResolvedValue(undefined);
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue(undefined);
		mode.ui.requestRender = vi.fn();

		const originalCwd = process.cwd();
		try {
			await mode.applyCwdChange(targetDir);

			expect(isolatedSettings.getCwd()).toBe(path.normalize(targetDir));
			expect(isolatedSettings.get("context.engine")).toBe("lossless");
			expect(isolatedSettings.get("context.lossless.maxConcurrentSummaries")).toBe(2);
			expect(refreshLcmSettingsAndRebind).toHaveBeenCalledTimes(1);
		} finally {
			setProjectDir(originalCwd);
		}
	});
});
