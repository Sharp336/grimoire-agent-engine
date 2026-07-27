import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";

describe("inputMode setting", () => {
	it("defaults to the standard editor and accepts Vim mode", () => {
		expect(Settings.isolated().get("inputMode")).toBe("default");
		expect(Settings.isolated({ inputMode: "vim" }).get("inputMode")).toBe("vim");
	});

	it("updates the live editor", () => {
		const setInputMode = vi.fn();
		const controller = new SelectorController({
			editor: { setInputMode },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("inputMode", "vim");

		expect(setInputMode).toHaveBeenCalledWith("vim");
	});
});
