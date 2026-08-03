import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("calculateCost", () => {
	it("keeps token-based calculation for GitHub Copilot models", () => {
		const model = {
			...getBundledModel("github-copilot", "gpt-4o"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 123,
				output: 456,
				cacheRead: 789,
				cacheWrite: 321,
				total: 1689,
			},
		};

		calculateCost(model, usage, Date.now());

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("keeps token-based calculation for non-Copilot providers", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		calculateCost(model, usage, Date.now());

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("prices provider orchestration tokens without changing visible usage buckets", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 100,
			output: 20,
			cacheRead: 50,
			cacheWrite: 10,
			totalTokens: 250,
			orchestration: { input: 25, output: 40, cacheRead: 5 },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage, Date.now());

		expect(usage.input).toBe(100);
		expect(usage.output).toBe(20);
		expect(usage.cacheRead).toBe(50);
		expect(usage.cost.input).toBeCloseTo(0.125, 8);
		expect(usage.cost.output).toBeCloseTo(0.12, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.0275, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.008, 8);
		expect(usage.cost.total).toBeCloseTo(0.2805, 8);
	});

	it("prices 1h cache writes at the 1h rate via the cttl breakdown (issue #6876)", () => {
		const model = getBundledModel("anthropic", "claude-opus-5");
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 344139,
			cttl: { ephemeral1h: 344139 },
			totalTokens: 344139,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage, Date.now());

		// 1h write bills at 2x base input ($5/MTok -> $10/MTok), not the 5m
		// scalar cost.cacheWrite ($6.25/MTok) which would give $2.15086875.
		expect(usage.cost.cacheWrite).toBeCloseTo(3.44139, 8);
		expect(usage.cost.total).toBeCloseTo(3.44139, 8);
	});

	it("prices a mixed 5m/1h cache write per component", () => {
		const model = getBundledModel("anthropic", "claude-opus-5");
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 300,
			cttl: { ephemeral5m: 100, ephemeral1h: 200 },
			totalTokens: 300,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage, Date.now());

		// 100 * $6.25/MTok (5m) + 200 * $10/MTok (1h).
		expect(usage.cost.cacheWrite).toBeCloseTo((6.25 * 100 + 10 * 200) / 1e6, 12);
	});

	it("prices cache-write tokens the breakdown does not account for at the flat rate", () => {
		// message_start supplied the 5m/1h split, a later message_delta bumped
		// cache_creation_input_tokens without repeating `cache_creation`. The
		// unattributed remainder must still be billed, never silently free.
		const model = getBundledModel("anthropic", "claude-opus-5");
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 1000,
			cttl: { ephemeral1h: 400 },
			totalTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage, Date.now());

		// 400 * $10/MTok (1h) + 600 unattributed * $6.25/MTok (flat 5m rate).
		expect(usage.cost.cacheWrite).toBeCloseTo((10 * 400 + 6.25 * 600) / 1e6, 12);
	});

	it("keeps the flat 5m rate for cache writes without a cttl breakdown", () => {
		const model = getBundledModel("anthropic", "claude-opus-5");
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 1000,
			totalTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage, Date.now());

		expect(usage.cost.cacheWrite).toBeCloseTo((6.25 * 1000) / 1e6, 12);
	});

	it("prices OpenAI Codex GPT models from the matching OpenAI catalog entry", () => {
		const openAIModel = getBundledModel("openai", "gpt-5.4");
		const codexModel = getBundledModel("openai-codex", "gpt-5.4");
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		expect(codexModel.cost).toEqual(openAIModel.cost);

		calculateCost(codexModel, usage, Date.now());

		expect(usage.cost.total).toBeCloseTo(0.01005, 8);
	});
});

describe("calculateCost peak pricing", () => {
	const peakModel = {
		...getBundledModel("github-copilot", "gpt-4o"),
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
		peakPricing: {
			windows: [
				{ startHour: 1, endHour: 4 },
				{ startHour: 6, endHour: 10 },
			],
			multiplier: 2,
		},
	};

	function inputCost(timestamp: number): number {
		const usage: Usage = {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(peakModel, usage, timestamp);
		return usage.cost.input;
	}

	it("applies the multiplier inside a window and keeps 1x outside", () => {
		// 2026-08-03: UTC 2 and 7 are in-window, 0, 4, 5, 10 are out.
		expect(inputCost(Date.UTC(2026, 7, 3, 2))).toBeCloseTo(2, 12);
		expect(inputCost(Date.UTC(2026, 7, 3, 7))).toBeCloseTo(2, 12);
		expect(inputCost(Date.UTC(2026, 7, 3, 0))).toBeCloseTo(1, 12);
		expect(inputCost(Date.UTC(2026, 7, 3, 5))).toBeCloseTo(1, 12);
		expect(inputCost(Date.UTC(2026, 7, 3, 23))).toBeCloseTo(1, 12);
	});

	it("treats windows as half-open [startHour, endHour)", () => {
		expect(inputCost(Date.UTC(2026, 7, 3, 1))).toBeCloseTo(2, 12); // start inclusive
		expect(inputCost(Date.UTC(2026, 7, 3, 4))).toBeCloseTo(1, 12); // end exclusive
		expect(inputCost(Date.UTC(2026, 7, 3, 10))).toBeCloseTo(1, 12);
	});

	it("wraps windows that cross midnight", () => {
		const wrapping = { ...peakModel, peakPricing: { windows: [{ startHour: 22, endHour: 2 }], multiplier: 2 } };
		const cost = (timestamp: number): number => {
			const usage: Usage = {
				input: 1_000_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			calculateCost(wrapping, usage, timestamp);
			return usage.cost.input;
		};
		expect(cost(Date.UTC(2026, 7, 3, 22))).toBeCloseTo(2, 12);
		expect(cost(Date.UTC(2026, 7, 3, 23))).toBeCloseTo(2, 12);
		expect(cost(Date.UTC(2026, 7, 3, 1))).toBeCloseTo(2, 12);
		expect(cost(Date.UTC(2026, 7, 3, 2))).toBeCloseTo(1, 12);
		expect(cost(Date.UTC(2026, 7, 3, 12))).toBeCloseTo(1, 12);
	});

	it("stays at 1x before the effective date even inside a window", () => {
		const dormant = {
			...peakModel,
			peakPricing: { ...peakModel.peakPricing, effectiveFrom: Date.UTC(2026, 9, 1) },
		};
		const usage: Usage = {
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(dormant, usage, Date.UTC(2026, 7, 3, 2));
		expect(usage.cost.input).toBeCloseTo(1, 12);
	});

	it("pins the multiplier to the request timestamp, not the calculation time", () => {
		// Off-peak request timestamp must stay 1x no matter when cost is recomputed.
		const offPeak = Date.UTC(2026, 7, 3, 12);
		expect(inputCost(offPeak)).toBeCloseTo(1, 12);
		expect(inputCost(offPeak)).toBeCloseTo(1, 12);
	});
});
