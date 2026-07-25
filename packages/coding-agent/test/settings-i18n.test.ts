import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getUi, SETTINGS_SCHEMA, TAB_GROUPS, TAB_METADATA } from "../src/config/settings-schema";
import { i18n } from "../src/i18n";
import { interceptGroupLabel, interceptTabLabel } from "../src/i18n/interceptor";
import {
	getAllSettingDefs,
	getSettingsForTab,
	invalidateSettingDefsCache,
} from "../src/modes/components/settings-defs";

describe("settings i18n integration", () => {
	let tempDir: string;
	let originalLang: string | undefined;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "settings-i18n-test-"));
		originalLang = process.env.OMP_LANG;
		process.env.OMP_LANG = "zh";
	});

	afterEach(async () => {
		if (originalLang !== undefined) {
			process.env.OMP_LANG = originalLang;
		} else {
			delete process.env.OMP_LANG;
		}
		// Restore the i18n singleton and settings defs cache to prevent test pollution
		i18n.reset();
		invalidateSettingDefsCache();
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	test("i18n.language setting exists in schema", async () => {
		const setting = (SETTINGS_SCHEMA as Record<string, unknown>)["i18n.language"];
		expect(setting).toBeDefined();
		expect((setting as { type: string }).type).toBe("string");
		expect((setting as { default: string }).default).toBe("en");
	});

	test("i18n.language setting has correct UI metadata", async () => {
		const ui = getUi("i18n.language");
		expect(ui).toBeDefined();
		expect(ui?.tab).toBe("interaction");
		expect(ui?.group).toBe("General");
		expect(ui?.label).toBe("Language");
		expect(ui?.description).toBe("UI language (applies on next screen refresh)");
	});

	test("TAB_METADATA has all required tabs", async () => {
		const requiredTabs = [
			"appearance",
			"model",
			"interaction",
			"context",
			"memory",
			"files",
			"shell",
			"tools",
			"tasks",
			"providers",
		];
		for (const tab of requiredTabs) {
			expect(TAB_METADATA[tab as keyof typeof TAB_METADATA]).toBeDefined();
			expect(TAB_METADATA[tab as keyof typeof TAB_METADATA].label).toBeTypeOf("string");
		}
	});

	test("TAB_GROUPS has General group in interaction tab", async () => {
		expect(TAB_GROUPS.interaction).toContain("General");
	});

	test("getTabLabel returns translated label when translation exists", async () => {
		// Create a translation file
		const translations = {
			"tabs.appearance.label": "外观",
			"tabs.model.label": "模型",
			"tabs.interaction.label": "交互",
		};
		await fs.promises.writeFile(path.join(tempDir, "zh-ui.json"), JSON.stringify(translations));

		// Initialize i18n with temp dir
		i18n.reset(tempDir);
		await i18n.init();

		expect(interceptTabLabel("appearance", "Appearance")).toBe("外观");
		expect(interceptTabLabel("model", "Model")).toBe("模型");
		expect(interceptTabLabel("interaction", "Interaction")).toBe("交互");
	});

	test("getTabLabel falls back to English when no translation", async () => {
		// Create empty translation file
		await fs.promises.writeFile(path.join(tempDir, "zh-ui.json"), JSON.stringify({}));

		i18n.reset(tempDir);
		await i18n.init();

		// Use a tab key that doesn't exist in any embedded translation
		// All real tabs (appearance, context, files, shell, etc.) have embedded zh translations
		expect(interceptTabLabel("nonexistent_tab", "Unknown Tab")).toBe("Unknown Tab");
	});

	test("getGroupLabel returns translated group when translation exists", async () => {
		const translations = {
			"tabs.interaction.groups.General": "常规",
			"tabs.interaction.groups.Input": "输入",
			"tabs.appearance.groups.Theme": "主题",
		};
		await fs.promises.writeFile(path.join(tempDir, "zh-groups.json"), JSON.stringify(translations));

		i18n.reset(tempDir);
		await i18n.init();

		expect(interceptGroupLabel("interaction", "General")).toBe("常规");
		expect(interceptGroupLabel("interaction", "Input")).toBe("输入");
		expect(interceptGroupLabel("appearance", "Theme")).toBe("主题");
	});

	test("getGroupLabel falls back to English when no translation", async () => {
		await fs.promises.writeFile(path.join(tempDir, "zh-groups.json"), JSON.stringify({}));

		i18n.reset(tempDir);
		await i18n.init();

		expect(interceptGroupLabel("interaction", "Misc")).toBe("Misc");
		expect(interceptGroupLabel("interaction", "Experimental")).toBe("Experimental");
	});

	test("getAllSettingDefs translates labels and descriptions", async () => {
		const translations = {
			"settings.theme.dark.label": "深色主题",
			"settings.theme.dark.description": "深色模式下使用的主题",
		};
		await fs.promises.writeFile(path.join(tempDir, "zh-settings.json"), JSON.stringify(translations));

		i18n.reset(tempDir);
		await i18n.init();

		const defs = getAllSettingDefs();
		const themeDarkDef = defs.find(d => d.path === "theme.dark");

		expect(themeDarkDef).toBeDefined();
		expect(themeDarkDef?.label).toBe("深色主题");
		expect(themeDarkDef?.description).toBe("深色模式下使用的主题");
	});

	test("getAllSettingDefs uses embedded translations when file is empty", async () => {
		await fs.promises.writeFile(path.join(tempDir, "zh-settings.json"), JSON.stringify({}));

		i18n.reset(tempDir);
		await i18n.init();

		// Must import and call the cache invalidation function since the previous test
		// cached Chinese translations at module level
		invalidateSettingDefsCache();

		const defs = getAllSettingDefs();
		const themeDarkDef = defs.find(d => d.path === "theme.dark");

		expect(themeDarkDef).toBeDefined();
		// Embedded zh translations are always loaded, so we get Chinese values
		expect(themeDarkDef?.label).toBe("深色主题");
		expect(themeDarkDef?.description).toBe("终端为深色背景时使用的主题");
	});

	test("i18n.language setting is included in interaction tab", async () => {
		await fs.promises.writeFile(path.join(tempDir, "zh-settings.json"), JSON.stringify({}));

		i18n.reset(tempDir);
		await i18n.init();

		const interactionSettings = getSettingsForTab("interaction");
		const langSetting = interactionSettings.find(s => s.path === "i18n.language");

		expect(langSetting).toBeDefined();
		expect(langSetting?.tab).toBe("interaction");
		expect(langSetting?.group).toBe("General");
	});
});
