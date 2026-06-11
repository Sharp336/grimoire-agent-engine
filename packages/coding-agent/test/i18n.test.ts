import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBuiltinSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { I18nRegistry, registerLocale, setLocale, setTranslationMode, t } from "@oh-my-pi/pi-coding-agent/i18n";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { getBuiltinSlashCommandDefs } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const ZH_HANS_TEST_TRANSLATIONS = {
	"demo.greeting": "你好，{name}",
	"settings.title": "设置",
	"settings.tab.appearance": "外观",
	"settings.theme.dark.label": "深色主题",
	"settings.ui.translationMode.label": "翻译显示模式",
	"slash.command.dump.acpDescription": "以纯文本返回完整会话记录",
	"slash.command.fast.acpInputHint": "[开|关|状态]",
	"slash.command.goal.inlineHint": "[目标]",
	"slash.command.goal.subcommand.set.usage": "<目标>",
	"slash.command.model.description": "选择模型（打开选择界面）",
};

function registerTestLocale(): void {
	registerLocale("zh-Hans", ZH_HANS_TEST_TRANSLATIONS);
}

afterEach(() => {
	setLocale("en");
	setTranslationMode("english");
});

describe("UI i18n", () => {
	test("renders translated and bilingual UI copy with interpolation", () => {
		registerTestLocale();
		setLocale("zh-Hans");
		setTranslationMode("translated");

		expect(t("demo.greeting", "Hello, {name}", { vars: { name: "Pi" } })).toBe("你好，Pi");

		setTranslationMode("bilingual");
		expect(t("demo.greeting", "Hello, {name}", { vars: { name: "Pi" } })).toBe("Hello, Pi / 你好，Pi");
	});

	test("localizes builtin slash command descriptions when commands are requested", () => {
		registerTestLocale();
		setLocale("zh-Hans");
		setTranslationMode("bilingual");

		const modelCommand = getBuiltinSlashCommandDefs().find(command => command.name === "model");

		expect(modelCommand?.description).toBe("Select model (opens selector UI) / 选择模型（打开选择界面）");
	});

	test("refreshes materialized builtin slash commands after a runtime locale flip", () => {
		registerTestLocale();
		setLocale("en");
		setTranslationMode("english");

		const englishGoal = getBuiltinSlashCommands().find(command => command.name === "goal");
		expect(englishGoal?.inlineHint).toBe("[objective]");

		setLocale("zh-Hans");
		setTranslationMode("translated");
		const translatedGoal = getBuiltinSlashCommands().find(command => command.name === "goal");

		expect(translatedGoal?.inlineHint).toBe("[目标]");
		expect(translatedGoal?.subcommands?.find(subcommand => subcommand.name === "set")?.usage).toBe("<目标>");
	});

	test("localizes ACP available-command metadata", async () => {
		registerTestLocale();
		setLocale("zh-Hans");
		setTranslationMode("bilingual");

		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [],
				skills: [],
				setSlashCommands: () => {},
				sessionManager: { getCwd: () => process.cwd() },
			} as never,
			async () => [],
		);
		const dumpCommand = commands.find(command => command.name === "dump");

		expect(dumpCommand?.description).toBe("Return full transcript as plain text / 以纯文本返回完整会话记录");
		const fastCommand = commands.find(command => command.name === "fast");
		expect(fastCommand?.input?.hint).toBe("[on|off|status] / [开|关|状态]");
	});

	test("available command localization is scoped to the session extension runtime", async () => {
		const zhRegistry = new I18nRegistry();
		zhRegistry.registerLocale("zh-Hans", ZH_HANS_TEST_TRANSLATIONS);
		zhRegistry.setLocale("zh-Hans");
		zhRegistry.setMode("translated");

		const enCommands = await buildAvailableSlashCommands(
			{
				extensionRunner: {
					t: (_key: string, fallback: string) => fallback,
					getRegisteredCommands: () => [],
				},
				customCommands: [],
				skills: [],
				setSlashCommands: () => {},
				sessionManager: { getCwd: () => process.cwd() },
			} as never,
			async () => [],
		);
		const zhCommands = await buildAvailableSlashCommands(
			{
				extensionRunner: {
					t: (
						key: string,
						fallback: string,
						vars?: Readonly<Record<string, string | number | boolean | undefined | null>>,
					) => zhRegistry.t(key, fallback, { vars }),
					getRegisteredCommands: () => [],
				},
				customCommands: [],
				skills: [],
				setSlashCommands: () => {},
				sessionManager: { getCwd: () => process.cwd() },
			} as never,
			async () => [],
		);

		expect(enCommands.find(command => command.name === "dump")?.description).toBe(
			"Return full transcript as plain text",
		);
		expect(zhCommands.find(command => command.name === "dump")?.description).toBe("以纯文本返回完整会话记录");
	});

	test("settings definitions refresh when translation state changes", () => {
		registerTestLocale();
		Settings.isolated();
		setLocale("zh-Hans");
		setTranslationMode("translated");

		const translated = getSettingsForTab("interaction").find(def => def.path === "ui.translationMode");
		expect(translated?.label).toBe("翻译显示模式");

		setTranslationMode("english");
		const english = getSettingsForTab("interaction").find(def => def.path === "ui.translationMode");
		expect(english?.label).toBe("Translation Mode");
	});

	test("settings definitions can localize with a session runtime translator", () => {
		const zhRegistry = new I18nRegistry();
		zhRegistry.registerLocale("zh-Hans", ZH_HANS_TEST_TRANSLATIONS);
		zhRegistry.setLocale("zh-Hans");
		zhRegistry.setMode("translated");
		setLocale("en");
		setTranslationMode("english");

		const english = getSettingsForTab("appearance").find(def => def.path === "theme.dark");
		const translated = getSettingsForTab("appearance", (key, fallback, options) =>
			zhRegistry.t(key, fallback, options),
		).find(def => def.path === "theme.dark");

		expect(english?.label).toBe("Dark Theme");
		expect(translated?.label).toBe("深色主题");
	});

	test("active settings selector refreshes materialized labels after a runtime locale flip", async () => {
		registerTestLocale();
		await Settings.init({ inMemory: true });
		setLocale("en");
		await initTheme(false);
		setTranslationMode("english");

		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["titanium"],
				cwd: process.cwd(),
			},
			{
				onChange: () => {},
				onCancel: () => {},
			},
		);
		expect(selector.render(120).join("\n")).toContain("Dark Theme");

		setLocale("zh-Hans");
		setTranslationMode("translated");
		selector.refreshLocalization();

		const rendered = selector.render(120).join("\n");
		expect(rendered).toContain("设置");
		expect(rendered).toContain("深色主题");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		expect(selector.render(120).join("\n")).toContain("深色主题");
	});
});
