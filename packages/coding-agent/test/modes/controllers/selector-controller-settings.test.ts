import { describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("refreshes skill state when skill prompt scope changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const refreshSkillState = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			refreshSkillState,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("skills.promptMode", "core");
		await Promise.resolve();

		expect(refreshSkillState).toHaveBeenCalledTimes(1);
		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
