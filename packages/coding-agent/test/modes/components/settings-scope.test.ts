import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	normalizeProviderMaxInFlightRequests,
	resetSettingsForTest,
	Settings,
	settings,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import {
	initTheme,
	onTerminalAppearanceChange,
	previewTheme,
	setTheme,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

beforeAll(async () => {
	await initTheme();
});

describe("SettingsSelectorComponent persistence scope", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let projectDir: string;
	let agentDir: string;
	let projectConfigPath: string;
	let changes: Array<{ path: string; value: unknown }>;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-scope-test-");
		projectDir = tempDir.join("project");
		agentDir = tempDir.join("agent");
		projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		// Global fallback disagrees with the project override so a shadowed
		// global edit is observable: effective (project) stays true.
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ ask: { enabled: false } }, null, 2));
		await Bun.write(projectConfigPath, YAML.stringify({ ask: { enabled: true }, custom: { keep: true } }, null, 2));
		await Settings.init({ cwd: projectDir, agentDir });
		changes = [];
	});

	afterEach(async () => {
		resetSettingsForTest();
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	function createSelector(): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
	}

	it("writes the global layer while callbacks receive the shadowing effective value", async () => {
		// Start both layers at true, then toggle only the global fallback to
		// false. The persisted scope and active effective value must diverge.
		settings.set("ask.enabled", true, "global");
		const selector = createSelector();
		expect(selector.render(120).join("\n")).toContain(`Settings · ${path.basename(projectDir)}`);
		expect(settings.getGlobalValue("ask.enabled")).toBe(true);
		expect(settings.get("ask.enabled")).toBe(true);

		// Alt+S switches to global scope; the row reflects the global layer
		// (true), so Enter writes false even though project remains true.
		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · global");
		for (const char of "ask tool interactive") selector.handleInput(char);
		selector.handleInput("\n");

		expect(settings.getGlobalValue("ask.enabled")).toBe(false);
		expect(settings.get("ask.enabled")).toBe(true);
		// Side-effect handlers receive the merged effective value, not the
		// global fallback displayed in the row.
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: true });

		await settings.flush();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
		});
	});

	it("inherits the global fallback when removing a project override", async () => {
		const selector = createSelector();
		// Locate the Ask row via search, then Esc lands on its tab with the row
		// selected so Delete can remove the project override in list mode.
		for (const char of "ask tool interactive") selector.handleInput(char);
		selector.handleInput("\x1b");
		selector.handleInput("\x1b[3~");

		expect(settings.get("ask.enabled")).toBe(false);
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: false });

		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({ custom: { keep: true } });
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
	});

	it("labels project scope with the directory name", () => {
		const selector = createSelector();
		expect(selector.render(120).join("\n")).toContain(`Settings · ${path.basename(projectDir)}`);
		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · global");
	});

	it("previews the selected scope's theme without persisting", () => {
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		expect(settings.get("theme.dark")).toBe("dark-one");
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("dark-one");
	});

	it("shows hindsight settings in global scope when only the global backend is hindsight", () => {
		settings.set("memory.backend", "hindsight", "global");
		settings.set("memory.backend", "off", "project");
		const selector = createSelector();
		expect(selector.render(120).join("\n")).not.toContain("Hindsight API URL");
		selector.handleInput("\x1bs");
		for (const char of "hindsight api") selector.handleInput(char);
		expect(selector.render(120).join("\n")).toContain("Hindsight API URL");
	});

	it("restores the effective theme when closing after a scope preview", () => {
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		// Alt+S previews the global layer's theme...
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		// ...closing restores the effective (project) theme without persisting.
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("dark-one");
		expect(settings.get("theme.dark")).toBe("dark-one");
	});
	it("keeps the dark/light theme slot of the terminal when closing after a preview", async () => {
		// This terminal is dark (test env). The project layer sets the dark
		// slot; Alt+S previews the global layer, which maps the DARK slot to a
		// LIGHT theme (alabaster) and the LIGHT slot to a dark theme
		// (titanium). The runtime swaps the exported theme and re-derives the
		// active theme name (setTheme). Closing must restore the effective
		// theme from the terminal's DARK slot (dark-one) — the dark/light
		// decision is captured once, not recomputed from the previewed theme.
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium", "alabaster"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: async themeName => {
					previews.push(themeName);
					await previewTheme(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "alabaster", "global");
		settings.set("theme.light", "titanium", "global");
		// Alt+S previews the global layer and the exported theme swaps to the
		// light theme; the active theme name now resolves to that light theme.
		selector.handleInput("\x1bs");
		await setTheme("alabaster");
		expect(previews.at(-1)).toBe("alabaster");
		expect(theme.isLight).toBe(true);
		// Closing restores the effective project theme (dark slot) — the
		// dark/light decision stays captured at the terminal's original mode
		// and must NOT pick the light slot despite the previewed theme.
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("dark-one");
		expect(settings.get("theme.dark")).toBe("dark-one");
	});
	it("restores from the dark slot when the dark slot itself holds a light theme", () => {
		// Terminal is dark (test env). The dark slot maps to a LIGHT theme
		// (alabaster), so the loaded theme/currentThemeName are light — but the
		// terminal's actual appearance is dark. Closing must restore the
		// effective theme from the terminal's own dark/light mode, read via
		// the reported appearance, not from the loaded theme's luminance.
		onTerminalAppearanceChange("dark");
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium", "alabaster"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "alabaster", "project");
		settings.set("theme.light", "titanium", "project");
		settings.set("theme.dark", "titanium", "global");
		settings.set("theme.light", "alabaster", "global");
		// Alt+S previews the global layer: the dark terminal picks the dark
		// slot, which is the dark theme titanium.
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		// Closing restores the effective project theme. The terminal is dark,
		// so it must come from the dark slot (alabaster) — even though the
		// loaded theme is light and currentThemeName reports a light theme.
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("alabaster");
		expect(settings.get("theme.dark")).toBe("alabaster");
	});

	it("keeps the selected scope's status-line baseline when canceling a submenu", () => {
		settings.set("statusLine.preset", "minimal", "project");
		settings.set("statusLine.preset", "full", "global");
		const previews: Array<{ preset?: string }> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onStatusLinePreview: payload => {
					previews.push(payload);
				},
				onCancel: () => {},
			},
		);
		// Global scope previews the global baseline (preset "full").
		selector.handleInput("\x1bs");
		// Open the Status Line Separator submenu and cancel it: the preview must
		// fall back to the full scoped baseline, not the effective project layer.
		for (const ch of "status line separator") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b");
		expect(previews.at(-1)?.preset).toBe("full");
	});
	it("clears a provider limit inherited from the global layer when editing in project scope", () => {
		// Global caps "anthropic"; the project layer has no override. A project
		// edit must be able to clear that cap without a leftover global record
		// key re-inheriting the cap through the record deep-merge.
		settings.set("providers.maxInFlightRequests", { anthropic: 3 }, "global");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: ["anthropic"],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
		// Switch to global scope, then back to project scope; open the
		// Max In-Flight Requests submenu and pick "Clear all limits".
		selector.handleInput("\x1bs");
		selector.handleInput("\x1bs");
		for (const ch of "max in flight requests") selector.handleInput(ch);
		selector.handleInput("\n");
		// "Clear all limits" is the second item in the submenu.
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\x1b");
		// Clear-all produced an empty map; the project scope must tombstone the
		// global provider so the effective limits are empty, not the global cap.
		expect(normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"))).toEqual({});
		expect(settings.get("providers.maxInFlightRequests")).toEqual({ anthropic: null });
		// The global layer itself is untouched.
		expect(settings.getGlobalValue("providers.maxInFlightRequests")).toEqual({ anthropic: 3 });
	});
});
