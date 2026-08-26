import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MINIMUM_NET_SAVINGS_USD,
	DEFAULT_WARM_BUDGET_RATIO,
	DEFAULT_WARM_SAFETY_MARGIN_USD,
	evaluateWarm,
	type WarmInputs,
	type WarmRates,
} from "@oh-my-pi/pi-ai/cache/economics";

/** Real `us.anthropic.claude-opus-5` Bedrock rate card, USD per 1e6 tokens. */
const OPUS_RATES: WarmRates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

const reference: WarmInputs = {
	prefixTokens: 120_000,
	// The whole prompt is the cached prefix, so a touch re-sends nothing at input price.
	// The pricing assertions below are stated against that shape.
	uncachedInputTokens: 0,
	rates: OPUS_RATES,
	resumeProbability: 0.95,
	cumulativeWarmCostUsd: 0,
	warmOutputTokens: 1,
};

describe("evaluateWarm", () => {
	it("defaults bound spend below the value it protects", () => {
		// Catches a budget ratio >= 1 (keepalive allowed to spend everything it saves)
		// or a nonzero default floor silently suppressing every warm.
		expect(DEFAULT_WARM_BUDGET_RATIO).toBe(0.7);
		expect(DEFAULT_WARM_SAFETY_MARGIN_USD).toBe(0);
		expect(DEFAULT_MINIMUM_NET_SAVINGS_USD).toBe(0);
	});

	it("prices the worked Opus reference case exactly", () => {
		// Catches any arithmetic drift in the gate: a wrong rate unit (1e3/1e9), cold
		// priced at input instead of cacheWrite when a write rate exists, a keepalive
		// cost that forgets the output token, or a budget ratio applied to the wrong term.
		const decision = evaluateWarm(reference);

		expect(decision.coldResumeCostUsd).toBeCloseTo(0.75, 10);
		expect(decision.cachedResumeCostUsd).toBeCloseTo(0.06, 10);
		expect(decision.avoidableLossUsd).toBeCloseTo(0.69, 10);
		expect(decision.expectedValueUsd).toBeCloseTo(0.6555, 10);
		expect(decision.nextWarmCostUsd).toBeCloseTo(0.060025, 10);
		expect(decision.maxWarmBudgetUsd).toBeCloseTo(0.45885, 10);
		expect(decision.remainingBudgetUsd).toBeCloseTo(0.45885, 10);
		expect(decision.action).toBe("warm");
		expect(decision.shouldWarm).toBe(true);
		expect(decision.reason).toBe("due-and-economically-positive");
	});

	it("still warms when the provider reports no cache-write rate (G5)", () => {
		// Upstream cachepilot priced a cold resume only at cacheWrite, so with no write
		// rate avoidable came out <= 0 and it never warmed. Cold must fall back to the
		// input rate: a cold resume genuinely costs full input price.
		const decision = evaluateWarm({ ...reference, rates: { ...OPUS_RATES, cacheWrite: 0 } });

		expect(decision.coldResumeCostUsd).toBeCloseTo(0.6, 10);
		expect(decision.avoidableLossUsd).toBeCloseTo(0.54, 10);
		expect(decision.avoidableLossUsd).toBeGreaterThan(0);
		expect(decision.expectedValueUsd).toBeCloseTo(0.513, 10);
		expect(decision.action).toBe("warm");
		expect(decision.shouldWarm).toBe(true);
	});

	it("skips when no continuation is expected", () => {
		// Catches burning keepalive touches after the final answer, when nobody resumes.
		const decision = evaluateWarm({ ...reference, resumeProbability: 0 });

		expect(decision.action).toBe("skip-no-continuation");
		expect(decision.shouldWarm).toBe(false);
		expect(decision.expectedValueUsd).toBe(0);
	});

	it("skips when the prefix size is unknown", () => {
		// Catches warming on a zero-token prefix, where there is no measurable loss and
		// every downstream ratio would be a division against nothing.
		const decision = evaluateWarm({ ...reference, prefixTokens: 0 });

		expect(decision.action).toBe("skip-unknown-pricing");
		expect(decision.shouldWarm).toBe(false);
		expect(decision.reason).toBe("prefix size unknown");
	});

	it("skips when the model carries no rate card", () => {
		// Distinct from the unknown-prefix case: the prefix is known but every rate is 0,
		// so the gate must refuse rather than conclude "free, therefore always warm".
		const decision = evaluateWarm({
			...reference,
			rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});

		expect(decision.action).toBe("skip-unknown-pricing");
		expect(decision.shouldWarm).toBe(false);
		expect(decision.reason).toBe("no rate card for this model");
	});

	it("stops once cumulative keepalive spend passes the budget", () => {
		// Catches a gate that ignores spend already made and keeps warming forever.
		const decision = evaluateWarm({ ...reference, cumulativeWarmCostUsd: 0.5 });

		expect(decision.action).toBe("economic-stop");
		expect(decision.shouldWarm).toBe(false);
		expect(decision.maxWarmBudgetUsd).toBeCloseTo(0.45885, 10);
		expect(decision.remainingBudgetUsd).toBeCloseTo(-0.04115, 10);
	});

	it("terminates: repeated warming reaches economic-stop in bounded iterations", () => {
		// The termination guarantee. Catches an unbounded watchdog that would keep paying
		// to protect a fixed expected value and eventually outspend the loss it prevents.
		let cumulativeWarmCostUsd = 0;
		let warmed = 0;
		let final = evaluateWarm({ ...reference, cumulativeWarmCostUsd });
		const limit = 1_000;

		while (final.shouldWarm && warmed < limit) {
			cumulativeWarmCostUsd += final.nextWarmCostUsd;
			warmed += 1;
			final = evaluateWarm({ ...reference, cumulativeWarmCostUsd });
		}

		expect(final.action).toBe("economic-stop");
		expect(warmed).toBeGreaterThan(0);
		expect(warmed).toBeLessThan(20);
		expect(cumulativeWarmCostUsd).toBeLessThanOrEqual(final.maxWarmBudgetUsd);
		expect(cumulativeWarmCostUsd).toBeLessThan(final.expectedValueUsd);
	});

	it("skips a prefix too small to pay for its own keepalive", () => {
		// With a 5-token prefix the billed output token alone costs more than the whole
		// expected saving. Catches a gate that compares value against 0 instead of
		// against the cost of the touch it is about to make.
		const decision = evaluateWarm({ ...reference, prefixTokens: 5 });

		expect(decision.avoidableLossUsd).toBeGreaterThan(0);
		expect(decision.expectedValueUsd).toBeLessThanOrEqual(decision.nextWarmCostUsd);
		expect(decision.action).toBe("skip-not-economic");
		expect(decision.shouldWarm).toBe(false);
	});

	it("skips when reading the cache is not cheaper than rebuilding it", () => {
		// Catches a gate that assumes cacheRead is always the cheap path; on a card where
		// it is not, warming pays to preserve a negative saving.
		const decision = evaluateWarm({
			...reference,
			rates: { input: 5, output: 25, cacheRead: 6.25, cacheWrite: 6.25 },
		});

		expect(decision.avoidableLossUsd).toBe(0);
		expect(decision.action).toBe("skip-not-economic");
		expect(decision.shouldWarm).toBe(false);
	});

	it("reports every cost field on a skip", () => {
		// The decision record is the explainability surface: a skip that reports nothing
		// cannot be audited, so no branch may leave a field undefined, NaN or Infinity.
		const decision = evaluateWarm({ ...reference, resumeProbability: 0 });

		for (const value of [
			decision.coldResumeCostUsd,
			decision.cachedResumeCostUsd,
			decision.avoidableLossUsd,
			decision.expectedValueUsd,
			decision.nextWarmCostUsd,
			decision.maxWarmBudgetUsd,
			decision.remainingBudgetUsd,
		]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(decision.nextWarmCostUsd).toBeCloseTo(0.060025, 10);
		expect(decision.remainingBudgetUsd).toBe(0);
		expect(decision.reason.length).toBeGreaterThan(0);
	});

	it("keeps shouldWarm in lockstep with action on every branch", () => {
		// Catches a branch that reports action "warm" while returning shouldWarm false
		// (or the reverse) — the two are read by different callers.
		const cases: WarmInputs[] = [
			reference,
			{ ...reference, rates: { ...OPUS_RATES, cacheWrite: 0 } },
			{ ...reference, resumeProbability: 0 },
			{ ...reference, prefixTokens: 0 },
			{ ...reference, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ ...reference, cumulativeWarmCostUsd: 0.5 },
			{ ...reference, prefixTokens: 5 },
			{ ...reference, prefixTokens: Number.NaN },
		];

		for (const input of cases) {
			const decision = evaluateWarm(input);
			expect(decision.shouldWarm).toBe(decision.action === "warm");
		}
	});

	it("honours explicit safety margin, net-savings floor and budget ratio", () => {
		// Catches defaults that are hardcoded rather than read from the inputs, which
		// would make a caller-tightened gate silently permissive.
		const margined = evaluateWarm({ ...reference, safetyMarginUsd: 1 });
		expect(margined.action).toBe("skip-not-economic");
		expect(margined.reason).toBe("touch costs more than the expected saving");

		const floored = evaluateWarm({ ...reference, minimumNetSavingsUsd: 1 });
		expect(floored.action).toBe("skip-not-economic");
		expect(floored.reason).toBe("net savings below minimum");

		// A ratio this tight leaves less budget than one touch costs, so the bound bites
		// on the very first touch.
		const tightBudget = evaluateWarm({ ...reference, budgetRatio: 0.05 });
		expect(tightBudget.maxWarmBudgetUsd).toBeCloseTo(0.032775, 10);
		expect(tightBudget.action).toBe("economic-stop");
		expect(tightBudget.shouldWarm).toBe(false);
	});
	it("bills the prompt outside the cached prefix at full input price", () => {
		// Failure mode: the touch was priced as cacheRead(prefix) + output only. Automatic
		// prefix caching routinely leaves a large uncached suffix, which the replay re-sends
		// at FULL input rate — so the real invoice can exceed the rebuild the gate thinks it
		// is avoiding, and the overrun is discovered only after the money is spent.
		const suffixed = evaluateWarm({ ...reference, uncachedInputTokens: 50_000 });

		// 120k @ $0.50/M cache read + 50k @ $5/M input + 1 @ $25/M output.
		const expected = (120_000 * 0.5) / 1e6 + (50_000 * 5) / 1e6 + (1 * 25) / 1e6;
		expect(suffixed.nextWarmCostUsd).toBeCloseTo(expected, 10);
		// Four times what the prefix-only price would have been: the omission was not a
		// rounding detail.
		expect(suffixed.nextWarmCostUsd).toBeGreaterThan(reference_nextWarmCost() * 4);

		// The avoided loss is untouched — a cold resume pays for the same suffix, so it
		// cancels and only the touch price moves.
		expect(suffixed.avoidableLossUsd).toBeCloseTo(evaluateWarm(reference).avoidableLossUsd, 10);
	});

	it("refuses a touch whose uncached suffix costs more than the rebuild it protects", () => {
		// The worked case from the review: a modest cached prefix behind a large uncached
		// suffix. Pricing only the cache read let this through as `warm`.
		const lopsided = evaluateWarm({ ...reference, prefixTokens: 20_000, uncachedInputTokens: 400_000 });
		expect(lopsided.nextWarmCostUsd).toBeGreaterThan(lopsided.avoidableLossUsd);
		expect(lopsided.action).toBe("skip-not-economic");
		expect(lopsided.shouldWarm).toBe(false);
	});

	it("refuses a non-finite uncached count instead of computing NaN costs", () => {
		// Same contract the other usage inputs have: every field of the record must be a
		// real number, so a bad input is rejected before any arithmetic.
		const broken = evaluateWarm({ ...reference, uncachedInputTokens: Number.NaN });
		expect(broken.action).toBe("skip-unknown-pricing");
		expect(broken.nextWarmCostUsd).toBe(0);
	});
});

/** Touch price for {@link reference}, where the whole prompt is cached. */
function reference_nextWarmCost(): number {
	return evaluateWarm(reference).nextWarmCostUsd;
}
