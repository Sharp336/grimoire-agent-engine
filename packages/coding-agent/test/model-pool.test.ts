import { describe, expect, it } from "bun:test";
import type { ModelUsageHealth, ModelUsageHealthOptions, ModelUsageHealthState } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	fetchPoolCandidateHealth,
	getPoolReserveFraction,
	getPoolSelectionMode,
	getPoolWeight,
	getPoolWeights,
	hashPoolSeed,
	isPoolHealthGateEnabled,
	type PoolCandidate,
	reorderPoolCandidates,
	selectPoolCandidate,
} from "@oh-my-pi/pi-coding-agent/session/model-pool";

function candidate(provider: string, id: string): PoolCandidate {
	return { selector: `${provider}/${id}`, provider, id };
}

const CLAUDE = candidate("anthropic", "claude-opus-5");
const CODEX = candidate("openai-codex", "gpt-5.5-codex");
const GEMINI = candidate("google", "gemini-3-pro");
const THREE = [CLAUDE, CODEX, GEMINI];

/** Weights {claude:1, codex:2, gemini:1}. Total 4, so the cut points are 0.25 and 0.75. */
const UNEVEN_WEIGHTS: Record<string, number> = {
	"anthropic/claude-opus-5": 1,
	"openai-codex/gpt-5.5-codex": 2,
	"google/gemini-3-pro": 1,
};

function drawFrom(candidates: readonly PoolCandidate[], seedText: string, weights: Record<string, number>) {
	return selectPoolCandidate(candidates, {
		seed: hashPoolSeed(seedText),
		weightFor: entry => getPoolWeight(entry.selector, entry.provider, weights),
	});
}

function healthMap(states: Record<string, ModelUsageHealthState>) {
	return (entry: PoolCandidate): ModelUsageHealthState | undefined => states[entry.selector];
}

describe("hashPoolSeed", () => {
	it("matches the pinned FNV-1a plus avalanche values", () => {
		// Pinned so a rewrite of the hash cannot silently reshuffle every user's picks.
		expect(hashPoolSeed("")).toBe(2872998923);
		expect(hashPoolSeed("a")).toBe(444641715);
		expect(hashPoolSeed("pool:")).toBe(2812150622);
		expect(hashPoolSeed("pool:model-pool-session")).toBe(1418829607);
		expect(hashPoolSeed("oh-my-pi")).toBe(3486808242);
	});

	it("stays inside the unsigned 32-bit range for long seeds", () => {
		const hash = hashPoolSeed(`pool:${"x".repeat(4096)}`);
		expect(hash).toBe(3946984860);
		expect(hash).toBeGreaterThanOrEqual(0);
		expect(hash).toBeLessThan(2 ** 32);
	});

	it("hashes UTF-8 bytes, so a two-byte character is not a one-byte code unit", () => {
		// "é" is 0xC3 0xA9 in UTF-8, giving a different value than plain "e".
		expect(hashPoolSeed("é")).toBe(2387039943);
		expect(hashPoolSeed("e")).toBe(2111704691);
	});

	it("spreads seed strings that differ only in a trailing character", () => {
		// The draw reads the high bits of the seed. Raw FNV-1a ends in a multiply by
		// 16777619, so seeds sharing a stem moved the high bits by well under 1% and
		// a whole burst landed on candidate 0. A spawn seed ends in the spawn name,
		// and those come out of the task tool in exactly these shapes: CamelCase, and
		// -2/-3/-4 suffixes appended to duplicates by the output manager.
		const groups = [
			["ScoutA", "ScoutB", "ScoutC", "ScoutD"],
			["reviewer-1", "reviewer-2", "reviewer-3", "reviewer-4"],
			["Worker", "Worker-2", "Worker-3", "Worker-4"],
			["agent-01", "agent-02", "agent-03", "agent-04"],
		];
		for (const group of groups) {
			const picks = group.map(id =>
				selectPoolCandidate([CLAUDE, CODEX], { seed: hashPoolSeed(`pool:${id}`), weightFor: () => 1 }),
			);
			expect(new Set(picks).size).toBeGreaterThan(1);
		}
	});
});

describe("getPoolWeight", () => {
	it("prefers an exact selector over a provider wildcard over the default", () => {
		const weights: Record<string, number> = {
			"anthropic/claude-opus-5": 5,
			"anthropic/*": 3,
		};
		expect(getPoolWeight("anthropic/claude-opus-5", "anthropic", weights)).toBe(5);
		expect(getPoolWeight("anthropic/claude-haiku-5", "anthropic", weights)).toBe(3);
		expect(getPoolWeight("google/gemini-3-pro", "google", weights)).toBe(1);
		expect(getPoolWeight("google/gemini-3-pro", "google", undefined)).toBe(1);
	});

	it("keeps an explicit zero instead of falling through to the wildcard", () => {
		const weights: Record<string, number> = { "anthropic/claude-opus-5": 0, "anthropic/*": 4 };
		expect(getPoolWeight("anthropic/claude-opus-5", "anthropic", weights)).toBe(0);
	});

	it("falls back to 1 for malformed weights so one typo cannot drop a provider", () => {
		const weights: Record<string, number> = {
			"anthropic/claude-opus-5": -2,
			"openai-codex/gpt-5.5-codex": Number.NaN,
			"google/gemini-3-pro": Number.POSITIVE_INFINITY,
		};
		expect(getPoolWeight("anthropic/claude-opus-5", "anthropic", weights)).toBe(1);
		expect(getPoolWeight("openai-codex/gpt-5.5-codex", "openai-codex", weights)).toBe(1);
		expect(getPoolWeight("google/gemini-3-pro", "google", weights)).toBe(1);
	});

	it("coerces a weight the config file quoted as a string", () => {
		// `retry.poolWeights` arrives as the raw settings record, so YAML like
		// `anthropic/claude-opus-5: "2"` reaches here as a string. Left alone it
		// would make the total NaN and stop the draw picking anything.
		const weights: Record<string, unknown> = { "anthropic/claude-opus-5": "2", "openai-codex/*": "fast" };
		expect(getPoolWeight("anthropic/claude-opus-5", "anthropic", weights)).toBe(1);
		expect(getPoolWeight("openai-codex/gpt-5.5-codex", "openai-codex", weights)).toBe(1);
	});

	it("lets a malformed exact weight fall through to the provider wildcard", () => {
		// A malformed value has to read as "no entry" rather than as an entry
		// weighing 1, or one YAML-quoted number silently shadows the wildcard the
		// user did write. `a/b: "2"` and `a/b:` with no value both land here.
		const quoted: Record<string, unknown> = { "anthropic/claude-opus-5": "2", "anthropic/*": 5 };
		expect(getPoolWeight("anthropic/claude-opus-5", "anthropic", quoted)).toBe(5);
		const empty: Record<string, unknown> = { "anthropic/claude-opus-5": null, "anthropic/*": 5 };
		expect(getPoolWeight("anthropic/claude-opus-5", "anthropic", empty)).toBe(5);
		const negative: Record<string, unknown> = { "anthropic/claude-opus-5": -3, "anthropic/*": 5 };
		expect(getPoolWeight("anthropic/claude-opus-5", "anthropic", negative)).toBe(5);
	});
});

describe("selectPoolCandidate", () => {
	it("picks the exact index each fixed seed lands on", () => {
		// Cumulative weights over [claude=1, codex=2, gemini=1] cut at 0.25 and 0.75
		// of the 32-bit seed space. These seeds normalize to 0.0131, 0.4592, 0.7923.
		expect(drawFrom(THREE, "draw-aa", UNEVEN_WEIGHTS)).toBe(0);
		expect(drawFrom(THREE, "draw-aaa", UNEVEN_WEIGHTS)).toBe(1);
		expect(drawFrom(THREE, "draw-baa", UNEVEN_WEIGHTS)).toBe(2);
	});

	it("returns the same index for the same seed, which is what makes resume stable", () => {
		expect(drawFrom(THREE, "draw-aa", UNEVEN_WEIGHTS)).toBe(0);
		expect(drawFrom(THREE, "draw-aa", UNEVEN_WEIGHTS)).toBe(0);
		expect(drawFrom(THREE, "draw-baa", UNEVEN_WEIGHTS)).toBe(2);
		expect(drawFrom(THREE, "draw-baa", UNEVEN_WEIGHTS)).toBe(2);
	});

	it("shifts the pick when only the weights change", () => {
		// Same seed, same candidates. Dropping claude to 0 hands its share to codex.
		expect(drawFrom(THREE, "draw-aa", UNEVEN_WEIGHTS)).toBe(0);
		expect(drawFrom(THREE, "draw-aa", { ...UNEVEN_WEIGHTS, "anthropic/claude-opus-5": 0 })).toBe(1);
	});

	it("never draws a zero-weight candidate but keeps it in the reordered list", () => {
		const weights: Record<string, number> = { "anthropic/claude-opus-5": 0 };
		for (const seedText of ["draw-baa", "draw-aaa", "draw-dca", "draw-aa", "draw-ab"]) {
			// Must be a real pick on one of the two weighted candidates, not `undefined`.
			expect(drawFrom(THREE, seedText, weights)).toBeOneOf([1, 2]);
		}
		const reordered = reorderPoolCandidates(THREE, drawFrom(THREE, "draw-dca", weights));
		expect(reordered.map(entry => entry.selector)).toEqual([
			"openai-codex/gpt-5.5-codex",
			"anthropic/claude-opus-5",
			"google/gemini-3-pro",
		]);
	});

	it("weighs a model listed twice once, so a thinking-level duplicate keeps an even split", () => {
		// `a/m,a/m:max,b/n` is a normal ordered list: one model at two thinking
		// levels. Both entries resolve to the same model, so claude must not take a
		// 2:1 share of a nominally even pool.
		const duplicated = [CLAUDE, CLAUDE, CODEX];
		expect(drawFrom(duplicated, "draw-aa", {})).toBe(0);
		expect(drawFrom(duplicated, "draw-aaa", {})).toBe(0);
		expect(drawFrom(duplicated, "draw-baa", {})).toBe(2);
		// The duplicate still rides along in the ordered fallback tail.
		expect(
			reorderPoolCandidates(duplicated, drawFrom(duplicated, "draw-baa", {})).map(entry => entry.selector),
		).toEqual(["openai-codex/gpt-5.5-codex", "anthropic/claude-opus-5", "anthropic/claude-opus-5"]);
	});

	it("skips the draw for a single candidate without asking for health", () => {
		const picked = selectPoolCandidate([CLAUDE], {
			seed: hashPoolSeed("pool:single"),
			weightFor: () => 1,
			healthFor: () => {
				throw new Error("health must not be consulted for a single candidate");
			},
		});
		expect(picked).toBeUndefined();
		expect(reorderPoolCandidates([CLAUDE], picked)).toEqual([CLAUDE]);
	});

	it("drops depleted and reserve candidates and lets unknown draw at full weight", () => {
		const states = healthMap({
			"anthropic/claude-opus-5": "depleted",
			"openai-codex/gpt-5.5-codex": "reserve",
			"google/gemini-3-pro": "unknown",
		});
		for (const seedText of ["draw-baa", "draw-aaa", "draw-dca"]) {
			expect(
				selectPoolCandidate(THREE, {
					seed: hashPoolSeed(seedText),
					weightFor: entry => getPoolWeight(entry.selector, entry.provider, UNEVEN_WEIGHTS),
					healthFor: states,
				}),
			).toBe(2);
		}
	});

	it("returns undefined when every candidate is depleted so the configured order stands", () => {
		const states = healthMap({
			"anthropic/claude-opus-5": "depleted",
			"openai-codex/gpt-5.5-codex": "depleted",
			"google/gemini-3-pro": "depleted",
		});
		const picked = selectPoolCandidate(THREE, {
			seed: hashPoolSeed("draw-dca"),
			weightFor: () => 1,
			healthFor: states,
		});
		expect(picked).toBeUndefined();
		expect(reorderPoolCandidates(THREE, picked)).toEqual(THREE);
	});

	it("returns undefined when every weight is zero", () => {
		expect(
			selectPoolCandidate(THREE, {
				seed: hashPoolSeed("draw-dca"),
				weightFor: () => 0,
			}),
		).toBeUndefined();
	});

	it("returns undefined when the weights sum past the floating point range", () => {
		// 1e308 is finite on its own, so it survives per-value validation, but two
		// of them total Infinity. That puts the cut point at Infinity and the last
		// entry would win every seed, a 100% share for whoever is listed last.
		const huge = { "anthropic/claude-opus-5": 1e308, "openai-codex/gpt-5.5-codex": 1e308 };
		for (const seedText of ["draw-aa", "draw-aaa", "draw-baa", "draw-dca"]) {
			expect(drawFrom([CLAUDE, CODEX], seedText, huge)).toBeUndefined();
		}
	});

	it("honours the eligibility check before health", () => {
		const seen: string[] = [];
		const picked = selectPoolCandidate(THREE, {
			seed: hashPoolSeed("draw-baa"),
			weightFor: () => 1,
			eligible: entry => entry.provider !== "anthropic",
			healthFor: entry => {
				seen.push(entry.selector);
				return "healthy";
			},
		});
		expect(picked).toBe(2);
		expect(seen).toEqual(["openai-codex/gpt-5.5-codex", "google/gemini-3-pro"]);
	});
});

describe("reorderPoolCandidates", () => {
	it("moves the pick to the front and keeps the rest in configured order", () => {
		expect(reorderPoolCandidates(THREE, 2).map(entry => entry.selector)).toEqual([
			"google/gemini-3-pro",
			"anthropic/claude-opus-5",
			"openai-codex/gpt-5.5-codex",
		]);
	});

	it("returns the input untouched for index 0, undefined, and out-of-range picks", () => {
		expect(reorderPoolCandidates(THREE, 0)).toBe(THREE);
		expect(reorderPoolCandidates(THREE, undefined)).toBe(THREE);
		expect(reorderPoolCandidates(THREE, 3)).toBe(THREE);
	});

	it("demotes spent candidates behind the healthy remainder", () => {
		// The remainder becomes a retry fallback chain, and the chain walk does not
		// consult usage health, so a depleted entry must not sit ahead of a healthy one.
		expect(reorderPoolCandidates(THREE, 1, index => index === 0).map(entry => entry.selector)).toEqual([
			"openai-codex/gpt-5.5-codex",
			"google/gemini-3-pro",
			"anthropic/claude-opus-5",
		]);
	});

	it("demotes spent candidates even when the pick is the configured first one", () => {
		expect(reorderPoolCandidates(THREE, 0, index => index === 1).map(entry => entry.selector)).toEqual([
			"anthropic/claude-opus-5",
			"google/gemini-3-pro",
			"openai-codex/gpt-5.5-codex",
		]);
	});

	it("leaves the configured order alone when no draw happened", () => {
		// Without a draw the configured order is what ordered selection would use,
		// so nothing may move: a healthy candidate hoisted to index 0 here would
		// hide a spent first candidate from the shipped fail-closed reserve policy.
		expect(reorderPoolCandidates(THREE, undefined, () => true)).toBe(THREE);
		expect(reorderPoolCandidates(THREE, undefined, index => index < 2)).toBe(THREE);
		expect(reorderPoolCandidates(THREE, undefined, index => index > 0)).toBe(THREE);
	});
});

describe("fetchPoolCandidateHealth", () => {
	it("asks once per candidate and passes the model, base url and reserve fraction through", async () => {
		const asked: Array<{ provider: string; options: ModelUsageHealthOptions }> = [];
		const source = {
			getModelUsageHealth: async (provider: string, options: ModelUsageHealthOptions): Promise<ModelUsageHealth> => {
				asked.push({ provider, options });
				return { state: "healthy", accounts: [] };
			},
		};
		const states = await fetchPoolCandidateHealth(
			[{ ...CLAUDE, baseUrl: "https://anthropic.example.test" }, CODEX],
			source,
			{ reserveFraction: 0.15, sessionId: "session-42" },
		);
		expect(states).toEqual(["healthy", "healthy"]);
		expect(asked.map(entry => entry.provider)).toEqual(["anthropic", "openai-codex"]);
		expect(asked[0].options.modelId).toBe("claude-opus-5");
		expect(asked[0].options.baseUrl).toBe("https://anthropic.example.test");
		expect(asked[0].options.reserveFraction).toBe(0.15);
		expect(asked[0].options.sessionId).toBe("session-42");
		expect(asked[1].options.modelId).toBe("gpt-5.5-codex");
		expect(asked[1].options.baseUrl).toBeUndefined();
	});

	it("fails open to unknown when a lookup throws", async () => {
		const source = {
			getModelUsageHealth: async (provider: string): Promise<ModelUsageHealth> => {
				if (provider === "anthropic") throw new Error("usage endpoint down");
				return { state: "depleted", accounts: [] };
			},
		};
		expect(await fetchPoolCandidateHealth([CLAUDE, CODEX], source, { reserveFraction: 0.1 })).toEqual([
			"unknown",
			"depleted",
		]);
	});

	it("reports unknown for ineligible candidates without calling the source", async () => {
		const asked: string[] = [];
		const source = {
			getModelUsageHealth: async (provider: string): Promise<ModelUsageHealth> => {
				asked.push(provider);
				return { state: "healthy", accounts: [] };
			},
		};
		const states = await fetchPoolCandidateHealth([CLAUDE, CODEX], source, {
			reserveFraction: 0.1,
			eligible: entry => entry.provider !== "anthropic",
		});
		expect(states).toEqual(["unknown", "healthy"]);
		expect(asked).toEqual(["openai-codex"]);
	});
});

describe("pool settings readers", () => {
	it("defaults to ordered selection with no weights and no health gate", () => {
		const settings = Settings.isolated();
		expect(getPoolSelectionMode(settings)).toBe("ordered");
		expect(getPoolWeights(settings)).toEqual({});
		expect(isPoolHealthGateEnabled(settings)).toBe(false);
		expect(getPoolReserveFraction(settings)).toBe(0.1);
	});

	it("reads the configured mode, weights and reserve fraction", () => {
		const settings = Settings.isolated({
			"retry.poolSelection": "weighted",
			"retry.poolWeights": { "anthropic/claude-opus-5": 2 },
			"retry.usageAwareFallback": true,
			"retry.usageReservePct": 25,
		});
		expect(getPoolSelectionMode(settings)).toBe("weighted");
		expect(getPoolWeights(settings)).toEqual({ "anthropic/claude-opus-5": 2 });
		expect(isPoolHealthGateEnabled(settings)).toBe(true);
		expect(getPoolReserveFraction(settings)).toBe(0.25);
	});

	it("keeps the health gate off when model fallback is disabled", () => {
		const settings = Settings.isolated({ "retry.usageAwareFallback": true, "retry.modelFallback": false });
		expect(isPoolHealthGateEnabled(settings)).toBe(false);
	});

	it("treats malformed pool weights as empty", () => {
		expect(getPoolWeights(Settings.isolated({ "retry.poolWeights": null as never }))).toEqual({});
		expect(getPoolWeights(Settings.isolated({ "retry.poolWeights": [1, 2] as never }))).toEqual({});
	});
});
