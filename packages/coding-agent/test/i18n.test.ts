import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_TUI_LOCALE,
	getTuiLocale,
	isSupportedTuiLocale,
	setTuiLocale,
	tuiMessage,
} from "@oh-my-pi/pi-coding-agent/i18n";

describe("i18n localization foundation", () => {
	let originalLocale: string;

	beforeEach(() => {
		originalLocale = getTuiLocale();
	});

	afterEach(() => {
		setTuiLocale(originalLocale);
	});

	it("should have DEFAULT_TUI_LOCALE as en-US", () => {
		expect(DEFAULT_TUI_LOCALE).toBe("en-US");
	});

	it("should default to en-US locale", () => {
		expect(getTuiLocale()).toBe("en-US");
	});

	it("should correctly detect supported and unsupported locales", () => {
		expect(isSupportedTuiLocale("en-US")).toBe(true);
		expect(isSupportedTuiLocale("fr-FR")).toBe(false);
		expect(isSupportedTuiLocale("zh-CN")).toBe(false);
	});

	it("should fall back to English when an explicit unsupported locale is requested", () => {
		const msgWithOptions = tuiMessage("settings.tabs.appearance", undefined, { locale: "fr-FR" });
		expect(msgWithOptions).toBe("Appearance");

		setTuiLocale("fr-FR");
		const msgWithGlobal = tuiMessage("settings.tabs.appearance");
		expect(msgWithGlobal).toBe("Appearance");
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
