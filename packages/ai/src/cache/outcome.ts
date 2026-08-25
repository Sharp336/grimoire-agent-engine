/**
 * Cache-outcome classification.
 *
 * The single most common way a cache optimizer lies to itself is treating "HTTP
 * 200" as a cache hit. It is not: providers with implicit caching report neither a
 * read nor a write bucket, so a successful request with zero/zero usage is
 * genuinely *unknown*. `success-unverified` is the honest answer there, and callers
 * must never fold it into evidence of a hit.
 */

import type { CacheOutcome } from "./types";

/**
 * Prompt-token floor below which a zero/zero cache reading carries no information:
 * providers do not cache prefixes this small, so the absence of cache tokens is
 * expected rather than a miss.
 *
 * The single definition of that floor. `cache-invalidation-marker.ts` reads it to
 * decide whether a collapsed `cacheRead` is a real invalidation, and the session's
 * observation recorder reads it to drop sub-threshold silence instead of filing it as
 * `success-unverified` — which `observeTtl` would charge confidence for, letting short
 * conversations erase the evidence real hits and misses earned.
 *
 * Classification itself is deliberately NOT gated on it: prompt size cannot turn an
 * unverified result into a verified one, it only tells you how surprising the
 * silence is. That decision belongs to whoever is about to persist the row.
 */
export const MIN_CACHE_FOOTPRINT = 2048;

/**
 * Classify one request against the provider cache.
 *
 * Ordered rules, first match wins:
 * 1. `!ok` -> `failed` — a failed request observed nothing, whatever usage claims.
 * 2. `cacheRead > 0` -> `confirmed-hit` — the only positive proof of reuse. Wins
 *    over a simultaneous write, which is just the tail of the prefix being extended.
 * 3. `cacheWrite > 0` -> `miss-rebuilt` — proof the entry was (re)built, not read.
 * 4. otherwise -> `success-unverified`.
 */
export function classifyCacheOutcome(input: {
	ok: boolean;
	cacheRead: number;
	cacheWrite: number;
	inputTokens: number;
}): CacheOutcome {
	if (!input.ok) return "failed";
	if (input.cacheRead > 0) return "confirmed-hit";
	if (input.cacheWrite > 0) return "miss-rebuilt";
	return "success-unverified";
}
