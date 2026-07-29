import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import {
	CacheInvalidationMarkerComponent,
	detectCacheInvalidation,
	reportCacheInvalidation,
} from "@oh-my-pi/pi-coding-agent/modes/components/cache-invalidation-marker";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CacheMutationLedger } from "@oh-my-pi/pi-coding-agent/session/cache-attribution";

function usage(parts: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Usage {
	const input = parts.input ?? 0;
	const output = parts.output ?? 0;
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("detectCacheInvalidation", () => {
	it("does not flag the first turn (no prior cache footprint)", () => {
		expect(detectCacheInvalidation(undefined, usage({ cacheWrite: 50_000, input: 2 }))).toBeUndefined();
	});

	it("flags a cacheRead collapse after a warm turn and reports reprocessed tokens", () => {
		// Mirrors the observed session: warm turn reads ~50k, next request reads
		// nothing and re-creates the whole prefix.
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 50_999 });
	});

	it("does not flag a cold turn whose predecessor only wrote the cache (never read it)", () => {
		// The session's opening request writes the prefix (cacheRead 0); a long
		// first tool call then outlives the provider's cache TTL, so the follow-up
		// re-writes cold. The cache was never proven live, so this is expected
		// warming/expiry — not a user-caused invalidation worth a marker right
		// under the opening message.
		const prev = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99 });
		const current = usage({ cacheRead: 0, cacheWrite: 51_113, input: 16 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag a turn that reused any cache", () => {
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		const current = usage({ cacheRead: 50_900, cacheWrite: 3_459, input: 2 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag implicit best-effort caches that report no cacheWrite", () => {
		// Gemini/antigravity and Fireworks/glm report `cacheWrite: 0` and drop
		// `cacheRead` to zero intermittently while the prefix is unchanged — a
		// provider propagation race that self-heals next turn, not an invalidation.
		// Mirrors the observed gemini-3.5-flash turn (warm 40.8k read, then a cold
		// 43.1k reprocess with zero cacheWrite).
		const prev = usage({ cacheRead: 40_789, input: 1_069, output: 353 });
		const current = usage({ cacheRead: 0, cacheWrite: 0, input: 43_102, output: 58 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("ignores collapses when the prior footprint was below the cacheable floor", () => {
		// No meaningful cache existed to invalidate (e.g. provider without prompt
		// caching, or a tiny early context).
		const prev = usage({ input: 500 });
		expect(detectCacheInvalidation(prev, usage({ input: 600 }))).toBeUndefined();
	});

	it("ignores a cold turn that reprocessed only a trivial prompt", () => {
		const prev = usage({ cacheRead: 40_000, cacheWrite: 1_000 });
		expect(detectCacheInvalidation(prev, usage({ cacheRead: 0, input: 12 }))).toBeUndefined();
	});
});

describe("CacheInvalidationMarkerComponent", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton (icons, rule glyph, colors).
		await initTheme();
	});

	it("renders a slim, left-aligned, partial-width divider padded by blank lines", () => {
		const lines = new CacheInvalidationMarkerComponent({ reprocessedTokens: 50_999 }).render(80);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("");
		expect(lines[2]).toBe("");
		// The divider spans only a short rule + label — well under the full width.
		const dividerWidth = Bun.stringWidth(lines[1]);
		expect(dividerWidth).toBeGreaterThan(0);
		expect(dividerWidth).toBeLessThan(80);
	});
});

describe("reportCacheInvalidation", () => {
	it("logs reprocessed tokens together with the mutator tag recorded this turn", () => {
		// Contract: a detected prefix loss is attributed to the message-array
		// mutators that fired on the losing turn, alongside the token cost and the
		// session-cumulative hit ratio.
		const ledger = new CacheMutationLedger();
		ledger.record("compaction");
		let captured: Record<string, unknown> | undefined;
		const fakeLogger = {
			warn: (_message: string, context?: Record<string, unknown>) => {
				captured = context;
			},
		};

		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });

		const invalidation = reportCacheInvalidation({
			prev,
			current,
			ledger,
			logger: fakeLogger,
			cumulativeUsage: { cacheRead: 9_000, cacheWrite: 5_000, input: 1_000 },
		});

		// Detection still surfaces the invalidation for the transcript marker.
		expect(invalidation).toEqual({ reprocessedTokens: 50_999 });
		const context = captured;
		if (!context) throw new Error("expected a warn call");
		expect(context.reprocessedTokens).toBe(50_999);
		expect(context.tags as string[]).toContain("compaction");
		// Same denominator as the status-line cache_hit segment: 9000 / (9000+5000+1000) = 60.
		expect(context.cumulativeHitRatio).toBe(60);
		// The ledger is consumed so a tag cannot leak to a later turn.
		expect([...ledger.tags]).toHaveLength(0);
	});

	it("consumes the ledger and stays silent when no invalidation is detected", () => {
		const ledger = new CacheMutationLedger();
		ledger.record("steering-wrap");
		const warns: unknown[] = [];
		const fakeLogger = { warn: () => warns.push(null) };

		// A turn that reused cache is not an invalidation.
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		const current = usage({ cacheRead: 50_900, cacheWrite: 3_459, input: 2 });
		const invalidation = reportCacheInvalidation({ prev, current, ledger, logger: fakeLogger });

		expect(invalidation).toBeUndefined();
		expect(warns).toHaveLength(0);
		// Still cleared so a non-losing turn's tags never attribute a later miss.
		expect([...ledger.tags]).toHaveLength(0);
	});

	it("consumes tags on a zero-usage turn so they never leak to a later miss", () => {
		// Contract: the ledger is consumed on every turn, including aborted or
		// all-zero responses that carry no prompt traffic. A tag recorded on such
		// a turn must not be mis-attributed to the next nonzero turn's miss.
		const ledger = new CacheMutationLedger();
		const contexts: Array<Record<string, unknown> | undefined> = [];
		const fakeLogger = {
			warn: (_message: string, context?: Record<string, unknown>) => contexts.push(context),
		};

		// A mutator fired on a turn that then reported all-zero usage (e.g. abort).
		const prevWarm = usage({ cacheRead: 50_000, cacheWrite: 980 });
		ledger.record("compaction");
		const zeroUsage = reportCacheInvalidation({
			prev: prevWarm,
			current: usage({}),
			ledger,
			logger: fakeLogger,
		});
		// Zero traffic is not an invalidation, and no warn fires — yet the tag was
		// consumed despite the empty turn.
		expect(zeroUsage).toBeUndefined();
		expect(contexts).toHaveLength(0);
		expect([...ledger.tags]).toHaveLength(0);

		// A later turn suffers a real prefix loss; the stale "compaction" tag
		// must NOT carry over from the consumed zero-usage turn.
		const missed = reportCacheInvalidation({
			prev: prevWarm,
			current: usage({ cacheRead: 0, cacheWrite: 50_000, input: 99 }),
			ledger,
			logger: fakeLogger,
		});
		expect(missed).toEqual({ reprocessedTokens: 50_099 });
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.tags as string[]).toEqual([]);
	});
});
