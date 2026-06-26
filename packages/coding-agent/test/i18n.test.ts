import { describe, expect, it } from "bun:test";
import {
	createTuiMessageResolver,
	DEFAULT_TUI_LOCALE,
	isSupportedTuiLocale,
	type TuiMessageCatalog,
	type TuiMessageKey,
	tuiMessage,
} from "@oh-my-pi/pi-coding-agent/i18n";

const TEST_EN_US_MESSAGES = {
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
} satisfies Record<TuiMessageKey, string>;

describe("i18n localization foundation", () => {
	it("should have DEFAULT_TUI_LOCALE as en-US", () => {
		expect(DEFAULT_TUI_LOCALE).toBe("en-US");
	});

	it("should correctly detect supported and unsupported locales", () => {
		expect(isSupportedTuiLocale("en-US")).toBe(true);
		expect(isSupportedTuiLocale("fr-FR")).toBe(false);
		expect(isSupportedTuiLocale("zh-CN")).toBe(false);
	});

	it("should fall back to English when an explicit unsupported locale is requested", () => {
		const msgWithOptions = tuiMessage("settings.tabs.appearance", undefined, { locale: "fr-FR" });
		expect(msgWithOptions).toBe("Appearance");
	});

	it("should fall back per key when a supported locale omits a message", () => {
		const testMessages = {
			[DEFAULT_TUI_LOCALE]: TEST_EN_US_MESSAGES,
			"x-test": {
				"historySearch.title": "Localized History",
			},
		} satisfies TuiMessageCatalog;
		const testMessage = createTuiMessageResolver(testMessages);

		expect(testMessage("historySearch.title", undefined, { locale: "x-test" })).toBe("Localized History");
		expect(testMessage("historySearch.empty", undefined, { locale: "x-test" })).toBe("No history yet");
	});

	it("should interpolate placeholders correctly", () => {
		const result = tuiMessage("settings.tabs.searchMatchLabel", {
			label: "Appearance",
			count: 3,
		});
		expect(result).toBe("Appearance (3)");
	});

	it("should preserve unknown placeholders", () => {
		const resultMissingCount = tuiMessage("settings.tabs.searchMatchLabel", {
			label: "Appearance",
		});
		expect(resultMissingCount).toBe("Appearance ({count})");

		const resultNoValues = tuiMessage("settings.tabs.searchMatchLabel", undefined);
		expect(resultNoValues).toBe("{label} ({count})");
	});

	it("should resolve settings tab keys to the exact existing English strings", () => {
		expect(tuiMessage("settings.tabs.appearance")).toBe("Appearance");
		expect(tuiMessage("settings.tabs.model")).toBe("Model");
		expect(tuiMessage("settings.tabs.interaction")).toBe("Interaction");
		expect(tuiMessage("settings.tabs.context")).toBe("Context");
		expect(tuiMessage("settings.tabs.memory")).toBe("Memory");
		expect(tuiMessage("settings.tabs.files")).toBe("Files");
		expect(tuiMessage("settings.tabs.shell")).toBe("Shell");
		expect(tuiMessage("settings.tabs.tools")).toBe("Tools");
		expect(tuiMessage("settings.tabs.tasks")).toBe("Tasks");
		expect(tuiMessage("settings.tabs.providers")).toBe("Providers");
		expect(tuiMessage("settings.tabs.plugins")).toBe("Plugins");
	});

	it("should resolve history-search keys to the exact existing English strings", () => {
		expect(tuiMessage("historySearch.title")).toBe("Search History");
		expect(tuiMessage("historySearch.empty")).toBe("No history yet");
		expect(tuiMessage("historySearch.noMatches")).toBe("No matching history");
		expect(tuiMessage("historySearch.hint.navigate")).toBe("navigate");
		expect(tuiMessage("historySearch.hint.select")).toBe("select");
		expect(tuiMessage("historySearch.hint.cancel")).toBe("cancel");
		expect(tuiMessage("historySearch.time.now")).toBe("now");
	});
});
