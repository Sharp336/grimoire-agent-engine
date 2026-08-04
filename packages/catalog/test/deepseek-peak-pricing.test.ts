import { describe, expect, it } from "bun:test";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyDeepSeekPeakPricing } from "../scripts/generated-policies";

function spec(overrides: Partial<ModelSpec> & Pick<ModelSpec, "id" | "provider">): ModelSpec {
	return {
		...overrides,
		name: overrides.id,
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

describe("applyDeepSeekPeakPricing", () => {
	const deepseekModel = spec({ id: "deepseek-v4-flash", provider: "deepseek" });
	const otherModel = spec({ id: "deepseek-v4-flash", provider: "fireworks" });
	const effectiveFrom = Date.UTC(2026, 9, 1);

	it("stays dormant while the effective date is unannounced", () => {
		const [model] = applyDeepSeekPeakPricing([deepseekModel]);
		expect(model.peakPricing).toBeUndefined();
		expect(model).toBe(deepseekModel);
	});

	it("stamps every DeepSeek model with Beijing peak windows once a date is set", () => {
		const [deepseek, other] = applyDeepSeekPeakPricing([deepseekModel, otherModel], effectiveFrom);
		expect(deepseek.peakPricing).toEqual({
			effectiveFrom,
			windows: [
				{ startHour: 1, endHour: 4 }, // Beijing 9-12
				{ startHour: 6, endHour: 10 }, // Beijing 14-18
			],
			multiplier: 2,
		});
		expect(other.peakPricing).toBeUndefined();
		expect(other).toBe(otherModel);
	});
});
