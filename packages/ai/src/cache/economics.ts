/**
 * Economic gate for prefix-cache keepalive ("warm") touches.
 *
 * A keepalive is a real billed request: it re-reads the whole cached prefix and
 * emits at least one output token. Firing one is only rational when the loss it
 * prevents — rebuilding the prefix from cold on resume — is worth more than the
 * touch costs, weighted by how likely a resume actually is.
 *
 * Every decision is returned as a fully populated {@link WarmDecision}, skips
 * included: the record is the explainability surface for "why did/didn't the
 * keepalive fire", so a skip that reports no numbers is a skip nobody can audit.
 */

/** Rate cards are quoted in USD per this many tokens. */
const RATE_UNIT_TOKENS = 1e6;

/**
 * Fraction of the expected avoided loss that cumulative keepalive spend may reach.
 * Below 1 by construction: a keepalive that is allowed to spend the entire value it
 * protects has protected nothing.
 */
export const DEFAULT_WARM_BUDGET_RATIO = 0.7;

/** Extra USD the expected value must clear before a touch is considered worth it. */
export const DEFAULT_WARM_SAFETY_MARGIN_USD = 0;

/** Minimum USD of net savings required after paying for this touch. */
export const DEFAULT_MINIMUM_NET_SAVINGS_USD = 0;

export interface WarmRates {
	/** USD per 1e6 uncached input tokens. */
	input: number;
	/** USD per 1e6 cache-read tokens. */
	cacheRead: number;
	/** USD per 1e6 cache-write tokens; 0 when the provider has no explicit write price. */
	cacheWrite: number;
	/** USD per 1e6 output tokens. */
	output: number;
}

export interface WarmInputs {
	/** Size of the cached prefix that would have to be rebuilt on a cold resume. */
	prefixTokens: number;
	rates: WarmRates;
	/** P(the session resumes and would have used this cache). */
	resumeProbability: number;
	/** USD already spent on keepalive touches for this lease. */
	cumulativeWarmCostUsd: number;
	/** Output tokens the keepalive touch will be billed for (0 or 1). */
	warmOutputTokens: number;
	/** Defaults to {@link DEFAULT_WARM_BUDGET_RATIO}. */
	budgetRatio?: number;
	/** Defaults to {@link DEFAULT_WARM_SAFETY_MARGIN_USD}. */
	safetyMarginUsd?: number;
	/** Defaults to {@link DEFAULT_MINIMUM_NET_SAVINGS_USD}. */
	minimumNetSavingsUsd?: number;
}

export type WarmAction =
	| "warm"
	| "economic-stop"
	| "skip-no-continuation"
	| "skip-not-economic"
	| "skip-unknown-pricing";

export interface WarmDecision {
	action: WarmAction;
	/** Always exactly `action === "warm"`. */
	shouldWarm: boolean;
	/** Short human-readable explanation of this action. */
	reason: string;
	/** USD to rebuild the prefix from cold on resume. */
	coldResumeCostUsd: number;
	/** USD to resume against a live cache entry. */
	cachedResumeCostUsd: number;
	/** USD the cache saves on resume: cold minus cached. */
	avoidableLossUsd: number;
	/** {@link avoidableLossUsd} weighted by resume probability. */
	expectedValueUsd: number;
	/** USD this one keepalive touch will cost. */
	nextWarmCostUsd: number;
	/** Ceiling on cumulative keepalive spend for this lease. */
	maxWarmBudgetUsd: number;
	/** Budget left after spend so far; negative once the ceiling is passed. */
	remainingBudgetUsd: number;
}

/**
 * Decide whether to fire one keepalive touch.
 *
 * All arithmetic happens up front so that every branch — including the skips —
 * reports the numbers that produced it; the ladder below is then pure ordered
 * comparison, matching the documented gate order exactly.
 */
export function evaluateWarm(inputs: WarmInputs): WarmDecision {
	const { prefixTokens, rates, resumeProbability, cumulativeWarmCostUsd, warmOutputTokens } = inputs;
	const budgetRatio = inputs.budgetRatio ?? DEFAULT_WARM_BUDGET_RATIO;
	const safetyMarginUsd = inputs.safetyMarginUsd ?? DEFAULT_WARM_SAFETY_MARGIN_USD;
	const minimumNetSavingsUsd = inputs.minimumNetSavingsUsd ?? DEFAULT_MINIMUM_NET_SAVINGS_USD;

	const decision: WarmDecision = {
		action: "skip-unknown-pricing",
		shouldWarm: false,
		reason: "",
		coldResumeCostUsd: 0,
		cachedResumeCostUsd: 0,
		avoidableLossUsd: 0,
		expectedValueUsd: 0,
		nextWarmCostUsd: 0,
		maxWarmBudgetUsd: 0,
		remainingBudgetUsd: 0,
	};
	// Nine exit branches close through here so `shouldWarm === (action === "warm")` is
	// derived in exactly one place and cannot drift branch by branch.
	const settle = (action: WarmAction, reason: string): WarmDecision => {
		decision.action = action;
		decision.shouldWarm = action === "warm";
		decision.reason = reason;
		return decision;
	};

	// A non-finite input can only yield non-finite cost fields, which would break the
	// promise that every field of the record is a real number. Refuse before computing.
	if (
		!(
			Number.isFinite(prefixTokens) &&
			Number.isFinite(resumeProbability) &&
			Number.isFinite(cumulativeWarmCostUsd) &&
			Number.isFinite(warmOutputTokens) &&
			Number.isFinite(budgetRatio) &&
			Number.isFinite(safetyMarginUsd) &&
			Number.isFinite(minimumNetSavingsUsd) &&
			Number.isFinite(rates.input) &&
			Number.isFinite(rates.cacheRead) &&
			Number.isFinite(rates.cacheWrite) &&
			Number.isFinite(rates.output)
		)
	) {
		return settle("skip-unknown-pricing", "non-finite pricing or usage input");
	}

	// G5 fix. A cold resume re-sends the prefix as uncached input; providers that also
	// charge to populate the cache bill that at the (higher) cache-write rate, and
	// providers with no explicit write price still bill full input price. Upstream
	// cachepilot priced a cold resume *only* at `cacheWrite`, so on any provider
	// reporting no write rate the avoidable loss came out <= 0 and it never warmed —
	// even though the cold resume genuinely costs full input price.
	const coldRate = rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
	const coldResumeCostUsd = (prefixTokens * coldRate) / RATE_UNIT_TOKENS;
	const cachedResumeCostUsd = (prefixTokens * rates.cacheRead) / RATE_UNIT_TOKENS;
	const avoidableLossUsd = coldResumeCostUsd - cachedResumeCostUsd;
	const expectedValueUsd = resumeProbability * avoidableLossUsd;
	const maxWarmBudgetUsd = expectedValueUsd * budgetRatio;
	const remainingBudgetUsd = maxWarmBudgetUsd - cumulativeWarmCostUsd;
	// A keepalive touch re-reads the whole prefix from cache and is billed for the
	// token(s) it emits.
	const nextWarmCostUsd =
		(prefixTokens * rates.cacheRead) / RATE_UNIT_TOKENS + (warmOutputTokens * rates.output) / RATE_UNIT_TOKENS;

	decision.coldResumeCostUsd = coldResumeCostUsd;
	decision.cachedResumeCostUsd = cachedResumeCostUsd;
	decision.avoidableLossUsd = avoidableLossUsd;
	decision.expectedValueUsd = expectedValueUsd;
	decision.nextWarmCostUsd = nextWarmCostUsd;
	decision.maxWarmBudgetUsd = maxWarmBudgetUsd;
	decision.remainingBudgetUsd = remainingBudgetUsd;

	// 1. Nothing to price against: an unknown prefix size or an empty rate card.
	if (prefixTokens <= 0) {
		return settle("skip-unknown-pricing", "prefix size unknown");
	}
	if (rates.input <= 0 && rates.cacheRead <= 0 && rates.cacheWrite <= 0 && rates.output <= 0) {
		return settle("skip-unknown-pricing", "no rate card for this model");
	}

	// 2. Nobody will resume, so there is no loss to avoid.
	if (resumeProbability <= 0) {
		return settle("skip-no-continuation", "no expected continuation");
	}

	// 3. Reading the cache costs at least as much as rebuilding it.
	if (avoidableLossUsd <= 0) {
		return settle("skip-not-economic", "cached resume is not cheaper than a cold one");
	}

	// 6. One touch costs more than the whole expected saving.
	if (expectedValueUsd <= nextWarmCostUsd + safetyMarginUsd) {
		return settle("skip-not-economic", "touch costs more than the expected saving");
	}

	// 7. Termination guarantee. Cumulative keepalive spend is capped at `budgetRatio`
	// of the expected value, so the touch chain provably halts. Without this bound a
	// keepalive is an unbounded watchdog that keeps paying to protect a fixed value
	// and eventually outspends the very loss it prevents.
	if (nextWarmCostUsd >= remainingBudgetUsd) {
		return settle("economic-stop", "keepalive budget exhausted");
	}

	// 8. Net savings after this touch must clear the configured floor.
	if (expectedValueUsd - (cumulativeWarmCostUsd + nextWarmCostUsd) < minimumNetSavingsUsd) {
		return settle("skip-not-economic", "net savings below minimum");
	}

	// 9.
	return settle("warm", "due-and-economically-positive");
}
