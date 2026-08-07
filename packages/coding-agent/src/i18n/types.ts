/** Supported UI locales. `system` follows env (LANG/LC_ALL), defaulting to English. */
export type UiLanguage = "system" | "en" | "zh-CN";

/** Resolved catalog locale (never `system`). */
export type ResolvedLocale = "en" | "zh-CN";

export type TranslateParams = Record<string, string | number | boolean | null | undefined>;
