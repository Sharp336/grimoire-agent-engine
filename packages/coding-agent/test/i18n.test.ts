import { describe, expect, it } from "bun:test";
import { TAB_METADATA } from "../src/config/settings-schema";
import { t, translate } from "../src/i18n";

describe("i18n", () => {
	it("returns English text for known keys", () => {
		expect(t("common.unknownError")).toBe("Unknown error");
		expect(t("historySearch.empty")).toBe("No matching history");
	});

	it("uses explicit locale resources", () => {
		expect(translate("en-US", "settings.tabs.appearance")).toBe("Appearance");
	});

	it("interpolates named placeholders", () => {
		expect(t("common.errorWithMessage", { message: "boom" })).toBe("Error: boom");
	});

	it("preserves existing settings tab labels through localized resources", () => {
		expect(TAB_METADATA.appearance.label).toBe("Appearance");
		expect(TAB_METADATA.model.label).toBe("Model");
		expect(TAB_METADATA.providers.label).toBe("Providers");
	});

	it("contains history search display strings", () => {
		expect(t("historySearch.title")).toBe("Search History (Ctrl+R)");
		expect(t("historySearch.help")).toBe("up/down navigate  enter select  esc cancel");
	});
});
