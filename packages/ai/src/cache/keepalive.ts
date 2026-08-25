/**
 * Provider capability resolution and policy surface for the prompt-cache keepalive.
 *
 * A keepalive touch is a real billed request whose only purpose is to prove the
 * cached prefix is still live and to restart the provider's retention clock. That
 * proof comes only from provider-reported cache telemetry, so a provider
 * qualifies only when BOTH hold:
 *
 * 1. it reports cache-read and cache-write token counts, so a touch can be
 *    classified — `cacheRead > 0 && cacheWrite === 0` is the only verified hit,
 *    and HTTP 200 is never one;
 * 2. its request shape can be bounded to near-zero output, so a touch costs about
 *    one cached prefix read instead of a whole completion.
 *
 * Deliberately excluded, and why — each of these fails (1), so a touch could never
 * be verified and the chain would be an unfalsifiable money burn:
 * - `anthropic-messages` resellers and gateways (Vertex-Anthropic, OpenRouter,
 *   GitHub Copilot, ZenMux, Cloudflare AI Gateway, Z.AI, Kimi): the wire format
 *   carries cache fields, but the retention being modeled is the upstream
 *   endpoint's, not theirs, and `pi-native` transports report another OMP
 *   harness's cache rather than one this process can re-anchor.
 * - OpenAI (`openai-completions`, `openai-responses`, Codex), Google Gemini and
 *   Vertex, DeepSeek, MiniMax, GitLab Duo, Ollama, Cursor, Devin: prompt caching
 *   is implicit and not separately reported, so a touch cannot be distinguished
 *   from an ordinary cheap prefill and there is no client-extendable lease.
 * - Bedrock models whose `promptCacheMode` is not `"explicit"`: with no
 *   `cachePoint` block there is no entry to re-anchor, and `"automatic"` prefix
 *   caching is not something a client can prolong.
 */

import { resolveTokenCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, ModelCost } from "@oh-my-pi/pi-catalog/types";
import type { WarmDecision, WarmRates } from "./economics";
import type { CacheOutcome } from "./types";

/**
 * `providerSessionState` key under which the keepalive keeps its per-session chain.
 *
 * The literal stays the historical `"anthropic-cache-refresh"` even though the
 * mechanism is now provider-agnostic: sessions already hold state under this key,
 * and renaming it would orphan their armed timers instead of cancelling them.
 */
export const CACHE_KEEPALIVE_STATE_KEY = "anthropic-cache-refresh";

/**
 * Touch budget when no {@link CacheKeepalivePolicy} is supplied.
 *
 * This is the pre-policy behavior verbatim — 3 touches at ~285s each, i.e. a hard
 * 19-minute ceiling — kept so callers that only set `anthropicCacheRefresh` see no
 * change at all.
 */
export const LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES = 3;

/**
 * Safety cap on touches per armed chain once a policy is supplied.
 *
 * With a policy the *economic* gate is what ends a chain; this only bounds the
 * pathological case where a provider keeps reporting cheap verified hits forever.
 */
export const DEFAULT_CACHE_KEEPALIVE_MAX_TOUCHES = 24;

/** One keepalive decision — fired or skipped — as handed to telemetry. */
export interface CacheKeepaliveRecord {
	/**
	 * Stable identity of the lease being kept warm: the cache fingerprint once
	 * identity is plumbed through the stream layer, otherwise the prompt-cache key
	 * or session id.
	 */
	fingerprint: string;
	/** Why the touch was or was not issued, with every number that produced it. */
	decision: WarmDecision;
	/** Classification of the touch that was issued; absent when it was skipped. */
	outcome?: CacheOutcome;
	/** Seconds since the previous verified touch (or since the turn that armed the chain). */
	idleSeconds: number;
	/** Tokens the touch read from cache; 0 for a skip. */
	cacheRead: number;
	/** Tokens the touch wrote to cache; 0 for a skip. */
	cacheWrite: number;
	/** USD the touch cost; 0 for a skip. */
	costUsd: number;
	/** 1-based position of this decision in the armed chain. */
	touchIndex: number;
	at: number;
}

/**
 * Cost-aware policy layered on top of the `anthropicCacheRefresh` switch.
 *
 * Without a policy the keepalive is a blind watchdog: it fires
 * {@link LEGACY_CACHE_KEEPALIVE_MAX_TOUCHES} touches after every assistant message,
 * including the final one of a turn nobody will resume. With one, each touch must
 * clear an economic gate first, so the chain lives exactly as long as it is worth
 * more than it costs.
 */
export interface CacheKeepalivePolicy {
	/**
	 * P(this session resumes and would have read the cache).
	 *
	 * Consulted immediately before every scheduled touch and never cached:
	 * background work finishing is exactly the event that should end the chain.
	 * `0` stops it; ~0.95 means pending async work will re-wake the loop.
	 */
	resumeProbability(): number;
	/** Size of the cached prefix, used to price the decision. */
	prefixTokens(): number;
	/** Called for every touch and every skip. Must never throw; a throw is swallowed. */
	onDecision?(record: CacheKeepaliveRecord): void;
	/** Safety cap on touches per armed chain. Defaults to {@link DEFAULT_CACHE_KEEPALIVE_MAX_TOUCHES}. */
	maxTouches?: number;
	/**
	 * Retention the provider is believed to honor, in seconds. Omitted uses the
	 * nominal short-cache lifetime; a caller with a learned per-route TTL profile
	 * (`resolveTtl`) supplies its estimate here.
	 */
	ttlSeconds?: number;
}

/**
 * How a keepalive touch must be issued for a given provider.
 *
 * - `zero-output`: a non-streaming request with a zero output budget. Anthropic's
 *   native API accepts `max_tokens: 0` and answers with usage only.
 * - `bounded-stream`: a streamed request with the smallest output budget the
 *   provider accepts, drained to completion.
 */
export type CacheKeepaliveShape = { kind: "zero-output" } | { kind: "bounded-stream"; maxTokens: number };

/**
 * AWS documents `InferenceConfiguration.maxTokens` with a "Minimum value of 1", so
 * a Bedrock touch cannot ask for zero output the way Anthropic's native API can —
 * and Bedrock Converse has no non-streaming route to ask on.
 */
const BEDROCK_MINIMUM_MAX_TOKENS = 1;

/**
 * Resolve how — or whether — {@link model} can be kept warm.
 *
 * `officialAnthropicEndpoint` is supplied by the caller rather than recomputed
 * here: deciding whether an Anthropic model resolves to the first-party endpoint
 * means mirroring Foundry redirection and the `ANTHROPIC_BASE_URL` gateway
 * fallback, which `stream.ts` already owns for the leaked-thinking heal. Passing
 * the answer in keeps exactly one such URL predicate in the codebase. The flag is
 * ignored for every non-Anthropic api.
 */
export function resolveCacheKeepaliveShape(
	model: Model<Api>,
	officialAnthropicEndpoint: boolean,
): CacheKeepaliveShape | undefined {
	if (model.api === "anthropic-messages") {
		if (model.provider !== "anthropic" || model.transport === "pi-native") return undefined;
		return officialAnthropicEndpoint ? { kind: "zero-output" } : undefined;
	}
	if (model.api === "bedrock-converse-stream") {
		const compat = model.compat as Model<"bedrock-converse-stream">["compat"];
		return compat.promptCacheMode === "explicit"
			? { kind: "bounded-stream", maxTokens: BEDROCK_MINIMUM_MAX_TOKENS }
			: undefined;
	}
	return undefined;
}

/**
 * Rate card for pricing a keepalive decision against a prefix of `promptTokens`.
 *
 * The context-length tier is resolved from the prefix size instead of reading
 * `cost.input` raw: on a long-context model the tier that will bill the resume is
 * the one the prefix reaches, and pricing a 400k-token prefix at the short-context
 * rate understates both the loss avoided and the touch itself.
 */
export function warmRatesForPrefix(cost: ModelCost, promptTokens: number): WarmRates {
	const rates = resolveTokenCost(cost, promptTokens);
	return { input: rates.input, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite, output: rates.output };
}
