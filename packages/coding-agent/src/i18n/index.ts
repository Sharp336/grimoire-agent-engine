import { enUS } from "./locales/en-US";

type TranslationTree = typeof enUS;
type LeafPaths<T, Prefix extends string = ""> = {
	[K in keyof T & string]: T[K] extends string
		? `${Prefix}${K}`
		: T[K] extends Record<string, unknown>
			? LeafPaths<T[K], `${Prefix}${K}.`>
			: never;
}[keyof T & string];

export type Locale = "en-US";
export type TranslationKey = LeafPaths<TranslationTree>;

type TranslationValues = Record<string, string | number | boolean>;

const LOCALES: Record<Locale, TranslationTree> = {
	"en-US": enUS,
};

function lookup(tree: TranslationTree, key: TranslationKey): string {
	let current: unknown = tree;
	for (const segment of key.split(".")) {
		if (!current || typeof current !== "object" || !(segment in current)) {
			return key;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return typeof current === "string" ? current : key;
}

function interpolate(template: string, values: TranslationValues | undefined): string {
	if (!values) return template;
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
		const value = values[name];
		return value === undefined ? match : String(value);
	});
}

export function translate(locale: Locale, key: TranslationKey, values?: TranslationValues): string {
	const resource = LOCALES[locale] ?? enUS;
	return interpolate(lookup(resource, key), values);
}

export function t(key: TranslationKey, values?: TranslationValues): string {
	return translate("en-US", key, values);
}
