export type LocaleCode = string;

export type TranslationMap = Readonly<Record<string, string>>;

export type TranslationMode = "english" | "translated" | "bilingual";

export interface TranslateOptions {
	mode?: TranslationMode;
	vars?: Readonly<Record<string, string | number | boolean | undefined | null>>;
}

export type TranslateFn = (key: string, fallback: string, options?: TranslateOptions) => string;

export class I18nRegistry {
	#locale: LocaleCode = "en";
	#mode: TranslationMode = "english";
	#version = 0;
	#maps = new Map<LocaleCode, Map<string, string>>();

	registerLocale(locale: LocaleCode, entries: TranslationMap): void {
		const normalized = normalizeLocale(locale);
		if (!normalized) return;
		let map = this.#maps.get(normalized);
		if (!map) {
			map = new Map<string, string>();
			this.#maps.set(normalized, map);
		}
		for (const [key, value] of Object.entries(entries)) {
			if (typeof key !== "string" || !key || typeof value !== "string") continue;
			map.set(key, value);
		}
		this.#version++;
	}

	setLocale(locale: LocaleCode | undefined): void {
		const normalized = normalizeLocale(locale);
		const next = normalized || "en";
		if (this.#locale === next) return;
		this.#locale = next;
		this.#version++;
	}

	getLocale(): LocaleCode {
		return this.#locale;
	}

	setMode(mode: TranslationMode | undefined): void {
		const next = mode === "translated" || mode === "bilingual" || mode === "english" ? mode : "english";
		if (this.#mode === next) return;
		this.#mode = next;
		this.#version++;
	}

	getMode(): TranslationMode {
		return this.#mode;
	}

	getVersion(): number {
		return this.#version;
	}

	t(key: string, fallback: string, options?: TranslateOptions): string {
		const text = fallback || "";
		if (!key) return interpolate(text, options?.vars);

		const translated = this.#maps.get(this.#locale)?.get(key) ?? this.#maps.get("en")?.get(key);
		if (!translated) return interpolate(text, options?.vars);

		const mode = options?.mode ?? this.#mode;
		if (mode === "english") return interpolate(text, options?.vars);
		if (mode === "translated") return interpolate(translated, options?.vars);
		if (translated === text) return interpolate(text, options?.vars);
		return interpolate(`${text} / ${translated}`, options?.vars);
	}
}

function normalizeLocale(locale: string | undefined): string {
	return typeof locale === "string" ? locale.trim() : "";
}

function interpolate(text: string, vars: TranslateOptions["vars"]): string {
	if (!vars) return text;
	let result = text;
	for (const [key, value] of Object.entries(vars)) {
		result = result.replaceAll(`{${key}}`, value == null ? "" : String(value));
	}
	return result;
}

export const i18n = new I18nRegistry();
export function createI18nRegistry(locale?: LocaleCode, mode?: TranslationMode): I18nRegistry {
	const registry = new I18nRegistry();
	registry.setLocale(locale);
	registry.setMode(mode);
	return registry;
}

export function registerLocale(locale: LocaleCode, entries: TranslationMap): void {
	i18n.registerLocale(locale, entries);
}

export function setLocale(locale: LocaleCode | undefined): void {
	i18n.setLocale(locale);
}

export function getLocale(): LocaleCode {
	return i18n.getLocale();
}

export function setTranslationMode(mode: TranslationMode | undefined): void {
	i18n.setMode(mode);
}

export function getTranslationMode(): TranslationMode {
	return i18n.getMode();
}

export function getI18nVersion(): number {
	return i18n.getVersion();
}

export function t(key: string, fallback: string, options?: TranslateOptions): string {
	return i18n.t(key, fallback, options);
}
