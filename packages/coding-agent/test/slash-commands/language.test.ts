import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getLanguage, setLanguage } from "@oh-my-pi/pi-coding-agent/i18n";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntime(settings: Settings) {
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const setText = vi.fn();
	const refreshSlashCommandState = vi.fn(async () => {});
	const requestRender = vi.fn();
	return {
		showStatus,
		showWarning,
		setText,
		refreshSlashCommandState,
		requestRender,
		runtime: {
			ctx: {
				settings,
				showStatus,
				showWarning,
				refreshSlashCommandState,
				ui: { requestRender },
				editor: { setText },
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/language", () => {
	afterEach(() => {
		setLanguage("en");
	});

	it("persists the selected language and refreshes command metadata", async () => {
		const settings = Settings.isolated();
		const runtime = createRuntime(settings);

		const handled = await executeBuiltinSlashCommand("/language zh-CN", runtime.runtime);

		expect(handled).toBe(true);
		expect(settings.get("language")).toBe("zh-CN");
		expect(getLanguage()).toBe("zh-CN");
		expect(runtime.refreshSlashCommandState).toHaveBeenCalledTimes(1);
		expect(runtime.requestRender).toHaveBeenCalledTimes(1);
		expect(runtime.showStatus.mock.calls[0]?.[0]).toContain("简体中文");
		expect(runtime.setText).toHaveBeenCalledWith("");
	});

	it("accepts aliases and reports invalid language values without changing settings", async () => {
		const settings = Settings.isolated();
		const runtime = createRuntime(settings);

		await executeBuiltinSlashCommand("/language 中文", runtime.runtime);
		await executeBuiltinSlashCommand("/language fr", runtime.runtime);

		expect(settings.get("language")).toBe("zh-CN");
		expect(runtime.showWarning).toHaveBeenCalledTimes(1);
		expect(runtime.showWarning.mock.calls[0]?.[0]).toContain("未知语言");
	});

	it("localizes built-in command descriptions after the language changes", () => {
		const runtime = createRuntime(Settings.isolated());
		setLanguage("zh-CN");
		const commands = buildTuiBuiltinSlashCommands(runtime.runtime as TuiSlashCommandRuntime);
		const settingsCommand = commands.find(command => command.name === "settings");

		expect(settingsCommand?.description).toBe("打开设置菜单");
	});

	it("persists the selected language in the user config", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-language-test-"));
		try {
			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
			settings.set("language", "zh-CN");
			await settings.flush();

			const reloaded = await Settings.loadIsolated({ agentDir, cwd: agentDir });
			expect(reloaded.get("language")).toBe("zh-CN");
		} finally {
			AgentStorage.resetInstance();
			// Bun keeps the Windows SQLite handle alive until process teardown.
		}
	});
});
