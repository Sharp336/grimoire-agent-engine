import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AUTO_THINKING, sessionSwitchThinkingOptions } from "@oh-my-pi/pi-coding-agent/thinking";

function modelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model anthropic/${id}`);
	return model;
}

/**
 * Contracts for the effort picker shown after a session-only model pick
 * (alt+p / `/switch`): when the picker is skipped (the switch applies the
 * fallback directly), which levels it offers, and which entry is highlighted.
 */
describe("sessionSwitchThinkingOptions", () => {
	it("skips the picker for a non-reasoning model", () => {
		const model = modelOrThrow("claude-3-5-sonnet-20241022");
		expect(model.reasoning).toBe(false);
		expect(sessionSwitchThinkingOptions(model, undefined)).toBeUndefined();
	});

	it("skips the picker for a reasoning model with no supported efforts", () => {
		const base = modelOrThrow("claude-sonnet-4-5");
		const model: Model<Api> = { ...base, reasoning: true, thinking: undefined };
		expect(getSupportedEfforts(model)).toEqual([]);
		expect(sessionSwitchThinkingOptions(model, ThinkingLevel.High)).toBeUndefined();
	});

	it("offers off, auto, and the model's supported efforts", () => {
		const model = modelOrThrow("claude-sonnet-4-5");
		const options = sessionSwitchThinkingOptions(model, undefined);
		expect(options).toBeDefined();
		expect(options?.levels).toEqual([ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)]);
	});

	it("preselects the role-configured fallback when it is a listed level", () => {
		const model = modelOrThrow("claude-sonnet-4-5");
		const options = sessionSwitchThinkingOptions(model, Effort.High);
		expect(options?.preselect).toBe(Effort.High);
	});

	it("falls back to the model default when the fallback is not listed (e.g. inherit)", () => {
		const model = modelOrThrow("claude-sonnet-4-5");
		const options = sessionSwitchThinkingOptions(model, ThinkingLevel.Inherit);
		expect(options?.preselect).not.toBe(ThinkingLevel.Inherit);
		expect(options?.preselect).toBe(model.thinking?.defaultLevel ?? AUTO_THINKING);
	});

	it("preselects auto when neither a fallback nor a model default applies", () => {
		const base = modelOrThrow("claude-sonnet-4-5");
		if (!base.thinking) throw new Error("Expected claude-sonnet-4-5 to have a thinking config");
		const model: Model<Api> = {
			...base,
			thinking: { ...base.thinking, defaultLevel: undefined },
		};
		const options = sessionSwitchThinkingOptions(model, undefined);
		expect(options?.preselect).toBe(AUTO_THINKING);
	});
});
