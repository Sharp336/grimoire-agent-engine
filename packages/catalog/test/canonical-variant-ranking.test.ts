import { describe, expect, test } from "bun:test";
import type { CanonicalModelVariant } from "@oh-my-pi/pi-catalog/identity/equivalence";
import {
	type CanonicalVariantPreferences,
	rankCanonicalVariants,
	resolveCanonicalVariant,
} from "@oh-my-pi/pi-catalog/identity/selection";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";

function variant(opts: {
	provider: string;
	id: string;
	canonicalId: string;
	source?: CanonicalModelVariant["source"];
}): CanonicalModelVariant {
	const selector = `${opts.provider}/${opts.id}`;
	return {
		canonicalId: opts.canonicalId,
		selector,
		source: opts.source ?? "heuristic",
		model: { id: opts.id, provider: opts.provider } as unknown as Model<Api>,
	};
}

function prefs(opts?: {
	providerRank?: Iterable<[string, number]>;
	modelOrder?: Iterable<[string, number]>;
}): CanonicalVariantPreferences {
	return {
		providerRank: new Map(opts?.providerRank ?? []),
		modelOrder: new Map(opts?.modelOrder ?? []),
	};
}

describe("rankCanonicalVariants / resolveCanonicalVariant", () => {
	test("resolve equals rank[0] for a single variant", () => {
		const variants = [variant({ provider: "openai", id: "gpt-5", canonicalId: "gpt-5" })];
		const preferences = prefs();
		const ranked = rankCanonicalVariants(variants, preferences);
		expect(ranked).toHaveLength(1);
		expect(resolveCanonicalVariant(variants, preferences)).toBe(ranked[0]!);
	});

	test("resolve equals rank[0] across multi-provider variants by provider rank", () => {
		const variants = [
			variant({ provider: "together", id: "llama-3", canonicalId: "llama-3" }),
			variant({ provider: "openrouter", id: "llama-3", canonicalId: "llama-3" }),
			variant({ provider: "aimlapi", id: "llama-3", canonicalId: "llama-3" }),
		];
		const preferences = prefs({
			providerRank: [
				["openrouter", 0],
				["aimlapi", 1],
				["together", 2],
			],
		});
		const ranked = rankCanonicalVariants(variants, preferences);
		expect(ranked.map(v => v.model.provider)).toEqual(["openrouter", "aimlapi", "together"]);
		expect(resolveCanonicalVariant(variants, preferences)).toBe(ranked[0]!);
	});

	test("resolve equals rank[0] when modelOrder breaks the final tie", () => {
		// Same provider rank, same exact-id status, same source, same id length:
		// only modelOrder distinguishes them.
		const variants = [
			variant({ provider: "openai", id: "abc", canonicalId: "xyz" }),
			variant({ provider: "openai", id: "def", canonicalId: "xyz" }),
		];
		const preferences = prefs({
			modelOrder: [
				["openai/def", 0],
				["openai/abc", 1],
			],
		});
		const ranked = rankCanonicalVariants(variants, preferences);
		expect(ranked.map(v => v.selector)).toEqual(["openai/def", "openai/abc"]);
		expect(resolveCanonicalVariant(variants, preferences)).toBe(ranked[0]!);
	});

	test("rank is byte-identical with resolve over a mixed variant set", () => {
		const variants = [
			variant({ provider: "fallbackco", id: "model-long-id", canonicalId: "canon", source: "fallback" }),
			variant({ provider: "openai", id: "canon", canonicalId: "canon", source: "bundled" }),
			variant({ provider: "anthropic", id: "canon-x", canonicalId: "canon", source: "override" }),
			variant({ provider: "heuristicco", id: "canon-y", canonicalId: "canon", source: "heuristic" }),
		];
		const preferences = prefs({
			providerRank: [
				["openai", 0],
				["anthropic", 0],
				["heuristicco", 1],
			],
			modelOrder: [["anthropic/canon-x", 5]],
		});
		const ranked = rankCanonicalVariants(variants, preferences);
		expect(ranked).toHaveLength(variants.length);
		expect(resolveCanonicalVariant(variants, preferences)).toBe(ranked[0]!);
		// resolve must always equal the head of the ranked chain.
		expect(resolveCanonicalVariant(variants, preferences)).toBe(rankCanonicalVariants(variants, preferences)[0]!);
	});

	test("empty input: resolve is undefined, rank is empty", () => {
		const preferences = prefs();
		expect(rankCanonicalVariants([], preferences)).toEqual([]);
		expect(resolveCanonicalVariant([], preferences)).toBeUndefined();
	});
});
