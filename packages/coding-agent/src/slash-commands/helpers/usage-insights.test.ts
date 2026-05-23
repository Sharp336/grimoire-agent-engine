import { describe, expect, test } from "bun:test";
import { _test } from "./usage-insights";

describe("usage insights", () => {
	test("reports large-context and uncached-prompt cost characteristics", () => {
		const insights = _test.computeInsights(
			{
				messages: [
					{
						sessionId: "a",
						timestamp: 1,
						cost: 2,
						input: 160_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
					},
					{
						sessionId: "b",
						timestamp: 2,
						cost: 1,
						input: 1_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
					},
				],
				sessionCosts: new Map([
					["a", 2],
					["b", 1],
				]),
			},
			new Set(),
		);

		expect(insights[0]?.percent).toBeCloseTo(66.666, 2);
		expect(insights.some(insight => insight.headline.includes(">150k context"))).toBe(true);
		expect(insights.some(insight => insight.headline.includes(">100k uncached prompts"))).toBe(true);
	});
});
