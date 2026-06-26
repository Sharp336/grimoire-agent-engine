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
export type TuiMessageValues = Record<string, boolean | number | string>;
export type TuiMessageBundle = Partial<Record<TuiMessageKey, string>>;
export type TuiMessageCatalog = Record<typeof DEFAULT_TUI_LOCALE, Record<TuiMessageKey, string>> &
	Record<string, TuiMessageBundle>;
export type TuiMessageOptions = { locale?: string };
export type TuiMessageResolver = (key: TuiMessageKey, values?: TuiMessageValues, options?: TuiMessageOptions) => string;

const TUI_MESSAGES = {
	[DEFAULT_TUI_LOCALE]: EN_US_TUI_MESSAGES,
} satisfies TuiMessageCatalog;

export type TuiLocale = keyof typeof TUI_MESSAGES;

export function isSupportedTuiLocale(locale: string): locale is TuiLocale {
	return locale in TUI_MESSAGES;
}

function interpolate(template: string, values: TuiMessageValues | undefined): string {
	if (!values) return template;
	return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (placeholder, name: string) => {
		const value = values[name];
		return value === undefined ? placeholder : String(value);
	});
}

export function createTuiMessageResolver(catalog: TuiMessageCatalog): TuiMessageResolver {
	const fallbackMessages = catalog[DEFAULT_TUI_LOCALE];
	return (key, values, options) => {
		const locale = options?.locale ?? DEFAULT_TUI_LOCALE;
		const messages = catalog[locale] ?? fallbackMessages;
		const template = messages[key] ?? fallbackMessages[key];
		return interpolate(template, values);
	};
}

export const tuiMessage = createTuiMessageResolver(TUI_MESSAGES);
