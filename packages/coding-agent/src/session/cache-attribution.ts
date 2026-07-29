/**
 * Prompt-cache attribution instrumentation.
 *
 * A provider prompt-cache prefix breaks when the message array sent on the wire
 * stops being a byte-stable extension of the previous request. Several distinct
 * mutators can cause that (compaction, secret obfuscation, image stripping,
 * steering wrapping, thinking demotion, retry-recovery history edits, tool
 * signature changes). Until now a break was *detected* (`detectCacheInvalidation`)
 * but never *attributed*: nothing recorded which mutator fired on the turn that
 * lost the prefix.
 *
 * This module is instrumentation only. It records short stable tags at each
 * mutator and offers the cumulative hit-ratio formula shared with the status
 * line, so an invalidation can be attributed to its cause. It changes no
 * mutator behavior and no detection threshold.
 */

/**
 * One literal tag per message-array mutator that can break a prompt-cache
 * prefix, so log output stays greppable. The set is closed: a new cause gets a
 * new member here, never a free-form string at a callsite.
 */
export type CacheMutationTag =
	| "compaction"
	| "obfuscate"
	| "image-strip"
	| "steering-wrap"
	| "thinking-demote"
	| "retry-recovery"
	| "tool-signature";

/**
 * Session-scoped ledger of which message-array mutators fired since the last
 * cache-invalidation report. Producers call {@link CacheMutationLedger.record};
 * the detection point calls {@link CacheMutationLedger.consume} once per turn,
 * so an invalidation is attributed to exactly the mutators active on the turn
 * that lost the prefix and tags never leak across turns.
 *
 * Intentionally minimal: a deduped, insertion-ordered tag set. It carries no
 * message content.
 */
export class CacheMutationLedger {
	#tags = new Set<CacheMutationTag>();
	#order: CacheMutationTag[] = [];

	/** Record that mutator `tag` rewrote the message array for the wire this turn. */
	record(tag: CacheMutationTag): void {
		if (this.#tags.has(tag)) return;
		this.#tags.add(tag);
		this.#order.push(tag);
	}

	/** Tags recorded so far this turn, without clearing. */
	get tags(): readonly CacheMutationTag[] {
		return this.#order;
	}

	/** Return the tags recorded since the last report, then clear the ledger. */
	consume(): readonly CacheMutationTag[] {
		const out = this.#order;
		this.#order = [];
		this.#tags.clear();
		return out;
	}

	/** Drop every recorded tag without reading them. */
	clear(): void {
		this.#order = [];
		this.#tags.clear();
	}
}

/** Structural prompt-traffic shape shared by per-turn `Usage` and cumulative usage stats. */
interface PromptTraffic {
	cacheRead: number;
	cacheWrite: number;
	input: number;
}

/**
 * Prompt-cache hit ratio over a usage accumulator, using the same denominator
 * as the per-turn status-line `cache_hit` segment — `cacheRead + cacheWrite +
 * input` — so the two numbers are directly comparable. Returns `null` when
 * there is no prompt traffic (denominator zero).
 *
 * Mirrors `cacheHitSegment` in `status-line/segments.ts`: hit rate is the cache
 * share of all prompt tokens, with uncached `input` kept in the denominator so
 * DeepSeek-style "miss reported as input" still yields hit / (hit + miss).
 */
export function computeCacheHitRatio(usage: PromptTraffic): number | null {
	const total = usage.cacheRead + usage.cacheWrite + usage.input;
	if (total <= 0) return null;
	return (usage.cacheRead / total) * 100;
}
