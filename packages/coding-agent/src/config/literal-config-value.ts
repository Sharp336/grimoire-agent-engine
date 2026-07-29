/**
 * Prefix values that must bypass models.yml command and environment expansion.
 * The prefix is doubled for a literal value that already starts with a backslash,
 * making the representation reversible for every string.
 */
const LITERAL_CONFIG_VALUE_PREFIX = "\\";

declare const literalConfigValueBrand: unique symbol;

/**
 * A models.yml secret/config value confirmed to be backslash-prefixed literal,
 * so it bypasses `!cmd` and environment expansion at runtime. The runtime
 * representation is an ordinary string; the brand only keeps the decode path
 * from ever running on a value that was not first confirmed literal.
 */
export type LiteralConfigValue = string & { readonly [literalConfigValueBrand]: true };

export function encodeLiteralConfigValue(value: string): string {
	return `${LITERAL_CONFIG_VALUE_PREFIX}${value}`;
}

export function isLiteralConfigValue(value: string | undefined): value is LiteralConfigValue {
	return value?.startsWith(LITERAL_CONFIG_VALUE_PREFIX) === true;
}

export function decodeLiteralConfigValue(value: LiteralConfigValue): string {
	return value.slice(LITERAL_CONFIG_VALUE_PREFIX.length);
}
