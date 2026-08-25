/**
 * Shared types for the prompt-cache intelligence layer.
 *
 * These describe a *physical* provider cache entry — the thing a request either
 * reads from or rebuilds — as opposed to a logical conversation. One session can
 * depend on several physical entries (model switch, side channel, subagent), and
 * one entry can outlive many turns, so identity is never keyed on a session id.
 */

/**
 * How long a provider should retain a prompt-cache entry.
 *
 * Declared here rather than in `../types` because the keepalive policy types this
 * module owns are referenced from `SimpleStreamOptions`; if the retention union lived
 * there, `../types` -> `cache/keepalive` -> `cache/types` -> `../types` would close a
 * circular type import, which measurably degrades inference in unrelated files.
 * `../types` re-exports this so every existing importer is unaffected.
 */
export type CacheRetention = "none" | "short" | "long";

/**
 * Everything that must match for a provider prefix cache to be reusable.
 *
 * Deliberately excludes output-shaping fields (`max_tokens`, `stream`, request
 * timeout): a keepalive touch differs from the request that created the entry in
 * exactly those fields and must still resolve to the same identity.
 *
 * `historyHash` is REQUIRED, not optional. Every provider we cache against places
 * its trailing breakpoint inside the message array — Anthropic on the last two
 * messages (`providers/anthropic.ts:3208-3219`), Bedrock on the final user block
 * (`providers/amazon-bedrock.ts:965-971`) — so the cached region ends in the
 * conversation, not at the tool array. Two consecutive turns of one session share
 * provider/model/endpoint/system/tools/key and differ *only* in history; without
 * `historyHash` they collide and a keepalive would believe turn N's entry is still
 * the live one after turn N+1 replaced it.
 */
export interface CacheIdentity {
	provider: string;
	api: string;
	modelId: string;
	/** Normalized endpoint including path: lowercase host, no query, no trailing slash. */
	endpoint: string;
	/** Opaque stable hash of the credential/account scope. Never the credential itself. */
	authScope: string;
	/** Provider prompt-cache key when the provider exposes one, else `""`. */
	promptCacheKey: string;
	/** Hash of the system-prompt blocks. */
	systemHash: string;
	/** Hash of the normalized tool array, order-sensitive. */
	toolsHash: string;
	/**
	 * Order-sensitive hash of the cacheable wire-history prefix — the messages up to
	 * and including the trailing cache breakpoint. Message order is semantic, so this
	 * must never be computed with a key-sorting structural hash.
	 */
	historyHash: string;
	/** Retention the entry was created under; a 5m and a 1h entry are different caches. */
	retention: CacheRetention;
}

/**
 * Aggregation key for learned TTL and latency, deliberately coarser than
 * {@link CacheIdentity}: how long a provider retains an entry is a property of the
 * route and the requested retention, not of one conversation.
 *
 * Upstream cachepilot keyed TTL learning on full cache identity (including a
 * `prompt_key` derived from the whole message history), so identity turned over
 * every single turn and no profile ever accumulated the observations its
 * confidence gate required. Keeping this key coarse is that fix.
 *
 * `retention` is part of the key because one route emits entries with genuinely
 * different lifetimes: Bedrock stamps `ttl: "1h"` only for long retention
 * (`providers/amazon-bedrock.ts:803`) and Anthropic likewise
 * (`providers/anthropic.ts:494`). Pooling 5m and 1h observations would learn a
 * mean that describes neither and schedule every keepalive at the wrong moment.
 * `retention: "none"` produces no cache entry at all and is never learned from.
 */
export interface RouteProfileKey {
	provider: string;
	api: string;
	modelId: string;
	endpoint: string;
	/** Provider-reported route when observable (gateway/region/upstream), else `""`. */
	route: string;
	/** Requested retention; separates 5m from 1h lifetimes. Never `"none"`. */
	retention: Exclude<CacheRetention, "none">;
}

/**
 * How a request resolved against the provider cache.
 *
 * `success-unverified` is a first-class outcome, not an error: providers with
 * implicit caching report neither read nor write tokens, and treating "HTTP 200"
 * as a hit is the single most common way a cache optimizer lies to itself.
 */
export type CacheOutcome = "confirmed-hit" | "miss-rebuilt" | "success-unverified" | "failed";

/** One observed interaction with a physical cache entry. */
export interface CacheTouch {
	outcome: CacheOutcome;
	cacheRead: number;
	cacheWrite: number;
	/** Idle seconds since the previous verified touch; `undefined` when unknown. */
	idleSeconds?: number;
	costUsd: number;
	at: number;
}
