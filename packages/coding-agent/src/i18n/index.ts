/**
 * Lightweight gettext-style UI i18n for omp.
 *
 * Design goals (PR 1):
 * - Zero new runtime dependencies
 * - English source strings are keys (gradual migration, easy diffs)
 * - Missing translations fall back to English
 * - Simple `{name}` interpolation for dynamic status lines
 *
 * Not in scope yet: plural rules, ICU messages, RTL, full CLI help extraction.
 */
import { zhCN } from "./locales/zh-CN";
import type { ResolvedLocale, TranslateParams, UiLanguage } from "./types";

export type { ResolvedLocale, TranslateParams, UiLanguage } from "./types";

const CATALOGS: Record<ResolvedLocale, Readonly<Record<string, string>>> = {
	en: {},
	"zh-CN": zhCN,
};

let locale: ResolvedLocale = "en";

/** Resolve `system` from process environment (LANG / LC_ALL). */
export function resolveSystemLocale(env: NodeJS.ProcessEnv = process.env): ResolvedLocale {
	const raw = (env.LC_ALL || env.LC_MESSAGES || env.LANG || "").toLowerCase();
	if (raw.startsWith("zh")) return "zh-CN";
	return "en";
}

export function resolveLocale(language: UiLanguage | string | undefined | null): ResolvedLocale {
	if (language === "zh-CN" || language === "zh" || language === "zh_CN") return "zh-CN";
	if (language === "en" || language === "en-US" || language === "en_US") return "en";
	if (language === "system" || language == null || language === "") return resolveSystemLocale();
	return "en";
}

export function getLocale(): ResolvedLocale {
	return locale;
}

export function setLocale(language: UiLanguage | string | undefined | null): ResolvedLocale {
	locale = resolveLocale(language);
	return locale;
}

/**
 * Translate `key` (English source) for the active locale.
 * Unknown keys return `key` unchanged so English remains the source of truth.
 */
export function t(key: string, params?: TranslateParams): string {
	if (!key) return key;
	const table = CATALOGS[locale] ?? CATALOGS.en;
	let out = table[key] ?? CATALOGS.en[key] ?? key;
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			if (value === undefined || value === null) continue;
			out = out.replaceAll(`{${name}}`, String(value));
		}
	}
	return out;
}

/** Apply UI language from settings (or env) at process start / on change. */
export function applyUiLanguage(language: UiLanguage | string | undefined | null): ResolvedLocale {
	return setLocale(language);
}
