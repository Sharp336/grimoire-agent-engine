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
	test("dedup key distinguishes different sessions at same timestamp", () => {
		const left = _test.buildMessageDedupKey({
			sessionId: "session-a",
			timestamp: 123,
			cost: 1,
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
		});
		const right = _test.buildMessageDedupKey({
			sessionId: "session-b",
			timestamp: 123,
			cost: 1,
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
		});

		expect(left).not.toBe(right);
	});
	test("parses task toolResult usage into insight messages", () => {
		const parsed = _test.parseSessionLine(
			JSON.stringify({
				type: "message",
				timestamp: "2026-05-24T00:00:00.000Z",
				message: {
					role: "toolResult",
					toolName: "task",
					details: {
						usage: {
							input: 10,
							output: 20,
							cacheRead: 30,
							cacheWrite: 40,
							cost: { total: 1.25 },
						},
					},
				},
			}),
			"session-1",
		);

		expect(parsed?.message).toEqual({
			sessionId: "session-1",
			timestamp: Date.parse("2026-05-24T00:00:00.000Z"),
			cost: 1.25,
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
		});
	});
});
