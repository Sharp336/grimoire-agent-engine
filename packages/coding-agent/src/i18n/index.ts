export const DEFAULT_TUI_LOCALE = "en-US";

const EN_US_TUI_MESSAGES = {
	"settings.tabs.appearance": "Appearance",
	"settings.tabs.model": "Model",
	"settings.tabs.interaction": "Interaction",
	"settings.tabs.context": "Context",
	"settings.tabs.memory": "Memory",
	"settings.tabs.files": "Files",
	"settings.tabs.shell": "Shell",
	"settings.tabs.tools": "Tools",
	"settings.tabs.tasks": "Tasks",
	"settings.tabs.providers": "Providers",
	"settings.tabs.plugins": "Plugins",
	"settings.tabs.searchMatchLabel": "{label} ({count})",
	"historySearch.title": "Search History",
	"historySearch.empty": "No history yet",
	"historySearch.noMatches": "No matching history",
	"historySearch.hint.navigate": "navigate",
	"historySearch.hint.select": "select",
	"historySearch.hint.cancel": "cancel",
	"historySearch.time.now": "now",
} as const;

export type TuiMessageKey = keyof typeof EN_US_TUI_MESSAGES;
const EN_US_TUI_MESSAGE_FALLBACK: Record<TuiMessageKey, string> = EN_US_TUI_MESSAGES;
type TuiMessageCatalog = Record<typeof DEFAULT_TUI_LOCALE, Record<TuiMessageKey, string>> &
	Record<string, Partial<Record<TuiMessageKey, string>>>;

const TUI_MESSAGES = {
	[DEFAULT_TUI_LOCALE]: EN_US_TUI_MESSAGES,
} satisfies TuiMessageCatalog;

export type TuiLocale = keyof typeof TUI_MESSAGES;
export type TuiMessageValues = Record<string, boolean | number | string>;

let currentTuiLocale: string = DEFAULT_TUI_LOCALE;

export function isSupportedTuiLocale(locale: string): locale is TuiLocale {
	return locale in TUI_MESSAGES;
}

export function setTuiLocale(locale: string): void {
	currentTuiLocale = locale;
}

export function getTuiLocale(): string {
	return currentTuiLocale;
}

function interpolate(template: string, values: TuiMessageValues | undefined): string {
	if (!values) return template;
	return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (placeholder, name: string) => {
		const value = values[name];
		return value === undefined ? placeholder : String(value);
	});
}

export function tuiMessage(key: TuiMessageKey, values?: TuiMessageValues, options?: { locale?: string }): string {
	const locale = options?.locale ?? currentTuiLocale;
	const fallback = EN_US_TUI_MESSAGE_FALLBACK[key];
	const messages = isSupportedTuiLocale(locale) ? TUI_MESSAGES[locale] : EN_US_TUI_MESSAGE_FALLBACK;
	const template = messages[key] ?? fallback;
	return interpolate(template, values);
}
