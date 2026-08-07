import { describe, expect, test } from "bun:test";
import { applyUiLanguage, getLocale, resolveLocale, resolveSystemLocale, t } from "./index";

describe("i18n", () => {
	test("resolveLocale maps zh variants and system", () => {
		expect(resolveLocale("zh-CN")).toBe("zh-CN");
		expect(resolveLocale("en")).toBe("en");
		expect(resolveLocale("system")).toBe(resolveSystemLocale());
		expect(resolveLocale(undefined)).toBe(resolveSystemLocale());
	});

	test("falls back to English key when untranslated", () => {
		applyUiLanguage("en");
		expect(t("Settings")).toBe("Settings");
		expect(t("Totally missing key xyz")).toBe("Totally missing key xyz");
	});

	test("translates known Settings chrome to zh-CN", () => {
		applyUiLanguage("zh-CN");
		expect(getLocale()).toBe("zh-CN");
		expect(t("Settings")).toBe("设置");
		expect(t("Welcome back!")).toBe("欢迎回来！");
		expect(t("Plugins")).toBe("插件");
		expect(t("Appearance")).toBe("外观");
	});

	test("interpolates {n} placeholders", () => {
		applyUiLanguage("zh-CN");
		// Seed may or may not have this key; still exercise replaceAll path.
		applyUiLanguage("en");
		expect(t("{n} matches", { n: 3 })).toBe("3 matches");
	});
});
