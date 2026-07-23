import { scheduler } from "node:timers/promises";
import { type FetchRetrySleepInfo, logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { parseRateLimitReason } from "../error/rate-limit";

/**
 * Marker + hint contract for transport-surfaced transient rate limits. THE
 * single formatter/parser pair — nothing else in the repo may construct or
 * regex this suffix. Tests pin the exact bytes.
 *
 * The hint carries a trailing `ms` unit (`; retry-after-ms: 503ms`) on purpose:
 * a bare digit run whose value is exactly a numeric status (503/529/500) would
 * otherwise sit between two word boundaries and get picked up by the rate-limit
 * classifier's `\b503\b`-style status patterns, reclassifying a transient
 * marker message as MODEL_CAPACITY/SERVER_ERROR. The `ms` suffix removes the
 * word boundary after the digits so `\b503\b` can never match the hint.
 */
const SURFACED_RATE_LIMIT_MARKER = "; rate limit surfaced for rotation";
const SURFACED_RATE_LIMIT_PATTERN = /; rate limit surfaced for rotation(?:; retry-after-ms: (\d+)ms)?/;

const RATE_LIMIT_ROTATION_BLOCK_MIN_MS = 5_000;
const RATE_LIMIT_ROTATION_BLOCK_MAX_MS = 120_000;
const RATE_LIMIT_ROTATION_DEFAULT_MS = 60_000;
const RATE_LIMIT_STALL_WARN_MS = 10_000;
export const RATE_LIMIT_STALL_MAX_RETRIES = 3;

// Floor for the in-place stall SLEEP (distinct from the credential-block
// duration policy in clampRateLimitRotationMs). A stall sleep honors the FULL
// server retry-after up to the decline threshold below — re-attempting the
// same key sooner than the server asked just burns a stall retry into a
// guaranteed repeat 429 — and the driver's abort signal keeps long sleeps
// interruptible. Floor keeps a spammy zero/tiny hint from hot-looping.
const RATE_LIMIT_STALL_MIN_SLEEP_MS = 5_000;

// Hints above this DECLINE the stall entirely (never truncate to it). For
// OpenAI-family transports the rotation-off baseline fails FAST on an over-cap
// hint — fetchWithRetry returns the 429 to the outer turn-retry/fallback
// layers instead of sleeping — so an unbounded stall would hold a request for
// e.g. 30 minutes where baseline surfaced in milliseconds. Declining matches
// that fail-fast shape: the driver breaks, the marker is stripped, and the
// terminal 429 reaches the outer layers.
const RATE_LIMIT_STALL_DECLINE_ABOVE_MS = 600_000;

/** Clamp a server retry hint into the short rotation-block window [5s, 120s]. */
export function clampRateLimitRotationMs(retryAfterMs: number | undefined): number {
	const base = retryAfterMs ?? RATE_LIMIT_ROTATION_DEFAULT_MS;
	return Math.min(RATE_LIMIT_ROTATION_BLOCK_MAX_MS, Math.max(RATE_LIMIT_ROTATION_BLOCK_MIN_MS, Math.round(base)));
}

/**
 * Compose the surfaced-rate-limit marker message. The output always contains
 * "rate limit" and multi-char words, so it can never classify as an opaque
 * status body. Both surface sites only compose markers over bases that already
 * classified `RATE_LIMIT_EXCEEDED`, so re-classifying the composed message
 * yields `RATE_LIMIT_EXCEEDED` by construction — except quota text in the
 * base, which wins the earlier QUOTA branch by design.
 */
export function formatSurfacedRateLimitMessage(baseMessage: string, retryAfterMs: number | undefined): string {
	const hint = retryAfterMs !== undefined ? `; retry-after-ms: ${Math.max(0, Math.round(retryAfterMs))}ms` : "";
	return `${baseMessage.trim()}${SURFACED_RATE_LIMIT_MARKER}${hint}`;
}

/**
 * Inverse of {@link formatSurfacedRateLimitMessage}: strip the marker suffix so
 * the terminal error a user sees is a clean base message. Kept beside the
 * formatter as the single source of truth for the marker bytes — call it ONLY
 * at the final emission point, never on messages still driving in-flight
 * rotation decisions.
 */
export function stripSurfacedRateLimitMarker(message: string): string {
	return message.replace(SURFACED_RATE_LIMIT_PATTERN, "");
}

export interface SurfacedRateLimit {
	retryAfterMs: number | undefined;
}

/** Parse the marker suffix out of an error message; undefined when absent. */
export function parseSurfacedRateLimit(message: string): SurfacedRateLimit | undefined {
	const match = SURFACED_RATE_LIMIT_PATTERN.exec(message);
	if (!match) return undefined;
	return { retryAfterMs: match[1] ? Number(match[1]) : undefined };
}

/** True when a message carries the surfaced-rate-limit marker suffix. */
export function isSurfacedRateLimitMessage(message: string): boolean {
	return SURFACED_RATE_LIMIT_PATTERN.test(message);
}

/**
 * Per-request rotation seam. Only inject when the request's apiKey is an
 * AuthStorage-backed resolver — surfaced marker errors are terminal otherwise.
 */
export interface RateLimitRotationOptions {
	enabled: boolean;
	/** Provider id of the per-request resolved model (logging + telemetry). */
	provider: string;
	/** Sleeps shorter than this are cheaper than a rotation; keep sleeping. */
	minSleepMs: number;
	/** MUST be bound to the per-request resolved provider. Errors → treated as "no sibling". */
	hasUsableSibling: () => boolean | Promise<boolean>;
	/** Fired by the streamSimple driver when a surfaced rate-limit failure was actually rotated to a new key. */
	onRotated?: (info: { provider: string; modelId?: string }) => void;
}

/**
 * Per-closure latch so one logical stall logs a single `rate_limit_stall`.
 * fetchWithRetry's `onBeforeSleep` and the anthropic wait hook both fire once
 * per provider retry attempt; without a shared flag a single stalled request
 * emits N duplicate warnings. Pass the SAME instance across a request/stream.
 */
export interface RateLimitStallOnce {
	warned: boolean;
}

/**
 * Structured warning for a long rate-limit sleep that could not rotate. When a
 * {@link RateLimitStallOnce} latch is supplied, warns at most once across the
 * request/stream that owns it (below-threshold sleeps never consume the latch).
 */
export function warnRateLimitStall(
	info: {
		provider: string;
		delayMs: number;
		source: string;
		attempt?: number;
	},
	once?: RateLimitStallOnce,
): void {
	if (info.delayMs < RATE_LIMIT_STALL_WARN_MS) return;
	if (once) {
		if (once.warned) return;
		once.warned = true;
	}
	logger.warn("rate_limit_stall", {
		provider: info.provider,
		delayMs: info.delayMs,
		source: info.source,
		attempt: info.attempt,
	});
}

/** onBeforeSleep gate for fetchWithRetry (OpenAI-family seam). */
export interface RateLimitSurfaceGate {
	onBeforeSleep: (info: FetchRetrySleepInfo) => Promise<"sleep" | "surface">;
	surfaced: boolean;
	surfacedRetryAfterMs: number | undefined;
}

/**
 * Build the fetchWithRetry `onBeforeSleep` gate: surface a transient 429
 * (`RATE_LIMIT_EXCEEDED` body classification only) instead of sleeping when
 * the pending delay is at least `minSleepMs` and a sibling credential exists.
 * Every other body class (UNKNOWN, MODEL_CAPACITY, QUOTA, SERVER_ERROR, empty)
 * stays in the transport's own backoff.
 */
export function createRateLimitSurfaceGate(rotation: RateLimitRotationOptions): RateLimitSurfaceGate {
	// One latch per request: fetchWithRetry re-enters this gate on every attempt,
	// so a persistent no-sibling stall would otherwise warn per attempt.
	const stallOnce: RateLimitStallOnce = { warned: false };
	// Only label a stall when the "sleep" decision actually sleeps: on the final
	// attempt and on an over-cap fail-fast hint fetchWithRetry returns the
	// response immediately, so a warn there would claim a sleep (up to 60s) for
	// a request that failed in milliseconds.
	const warnStall = (info: FetchRetrySleepInfo): void => {
		if (!info.willSleep) return;
		warnRateLimitStall(
			{
				provider: rotation.provider,
				delayMs: info.delayMs,
				source: "fetch-retry",
				attempt: info.attempt,
			},
			stallOnce,
		);
	};
	const gate: RateLimitSurfaceGate = {
		surfaced: false,
		surfacedRetryAfterMs: undefined,
		onBeforeSleep: async info => {
			if (!rotation.enabled || info.response.status !== 429) return "sleep";
			// Decide on the BODY, not the status: only an exact transient
			// rate-limit classification is worth burning a rotation on.
			if (parseRateLimitReason(info.bodyText) !== "RATE_LIMIT_EXCEEDED") return "sleep";
			if (info.delayMs < rotation.minSleepMs) {
				// Below minSleepMs stays in the transport backoff (cheaper than a
				// rotation), but a configured minSleepMs above the 10s warn threshold
				// can make that an un-rotated >=10s sleep — the same stall the
				// provider-retry seam warns on, so warn here too (self-gated on
				// duration and the latch).
				warnStall(info);
				return "sleep";
			}
			let sibling = false;
			try {
				sibling = await rotation.hasUsableSibling();
			} catch {
				// Treated as "no sibling": rotation is advisory, sleeping is safe.
			}
			if (!sibling) {
				warnStall(info);
				return "sleep";
			}
			gate.surfaced = true;
			gate.surfacedRetryAfterMs = info.retryHintMs ?? info.delayMs;
			return "surface";
		},
	};
	return gate;
}

/**
 * Rewrite a captured terminal 429 into the marker form (single formatter).
 * Mutates the message in place and returns the SAME instance so concrete
 * subclass identity and fields survive (OpenAIHttpError carries
 * `captured`/`code` consumed by strict-tools fallback; AnthropicApiError
 * carries `headers` — incl. retry-after — inspected downstream).
 */
export function toSurfacedRateLimitError<E extends Error>(error: E, retryAfterMs: number | undefined): E {
	error.message = formatSurfacedRateLimitMessage(error.message, retryAfterMs);
	return error;
}

/**
 * Anthropic seam: replaces the raw providerRetryWait/scheduler.wait dispatch.
 * Byte-identical delegation when `rateLimitRotation` is absent. When rotation
 * should fire, throws the ORIGINAL cause with its message rewritten to the
 * marker form instead of sleeping.
 */
export async function waitBeforeProviderRetry(
	delayMs: number,
	options:
		| {
				signal?: AbortSignal;
				providerRetryWait?: (delayMs: number, signal?: AbortSignal, cause?: unknown) => Promise<void>;
				rateLimitRotation?: RateLimitRotationOptions;
		  }
		| undefined,
	cause: unknown,
	stallOnce?: RateLimitStallOnce,
): Promise<void> {
	const rotation = options?.rateLimitRotation;
	if (rotation?.enabled && AIError.status(cause) === 429) {
		const message = cause instanceof Error ? cause.message : undefined;
		// Decide on the BODY, not the status: only an exact transient rate-limit
		// classification is worth surfacing for rotation OR labelling as a stall.
		// Capacity/server/unknown 429s sleep unlabeled in the transport backoff.
		if (message !== undefined && parseRateLimitReason(message) === "RATE_LIMIT_EXCEEDED") {
			if (delayMs >= rotation.minSleepMs) {
				let sibling = false;
				try {
					sibling = await rotation.hasUsableSibling();
				} catch {
					// Treated as "no sibling": fall through to the normal wait.
				}
				if (sibling) {
					// Surface the ORIGINAL error object (marker rewritten in place) so
					// subclass identity and fields — e.g. AnthropicApiError headers with
					// retry-after — survive for downstream turn-retry/fallback
					// classification. `message` is only defined when the cause is an
					// Error, so the synthesized fallback below is unreachable today; it
					// exists for type narrowing, not as a second formatter path.
					if (cause instanceof Error) throw toSurfacedRateLimitError(cause, delayMs);
					throw new AIError.ProviderHttpError(formatSurfacedRateLimitMessage(message, delayMs), 429);
				}
			}
			warnRateLimitStall({ provider: rotation.provider, delayMs, source: "provider-retry" }, stallOnce);
		}
	}
	if (options?.providerRetryWait) return options.providerRetryWait(delayMs, options.signal, cause);
	await scheduler.wait(delayMs, { signal: options?.signal });
}

/**
 * Pure stall decision for the streamSimple driver: when rotation declined
 * (sibling raced away / pool cycled) on a surfaced failure, how long should
 * the driver sleep in place before re-attempting the same key? `undefined`
 * means "don't stall — surface the failure".
 *
 * Stall-duration policy, in full (single place — don't re-derive per review):
 * - Hints up to {@link RATE_LIMIT_STALL_DECLINE_ABOVE_MS} (10 min) sleep the
 *   FULL parsed server hint (5s floor, NEVER truncated) — not the
 *   clampRateLimitRotationMs block window. Truncating a long hint re-attempts
 *   the same credential before the server's retry-after elapses, burning the
 *   stall budget on guaranteed repeat 429s into a terminal failure.
 * - Hints ABOVE the threshold decline the stall entirely (undefined → the
 *   terminal 429 reaches the outer turn-retry/fallback layers). The
 *   OpenAI-family transports already fail fast above their own per-delay caps
 *   (60s fetch-retry default, 300s codex budget), and a "transient" rate-limit
 *   hint above 10 minutes is quota-shaped — waits of that magnitude belong to
 *   the outer layers, not an in-place hold. Sleeping an UNBOUNDED hint would be
 *   worse than the rotation-off baseline: a 30-minute hint would hold the
 *   request where baseline surfaced it in ms.
 * - The 10-minute threshold deliberately sits BETWEEN the two transport
 *   baselines: the anthropic baseline sleep-and-retries arbitrarily long
 *   hints, the openai baseline fails fast above its cap. This stall path only
 *   exists for the raced-away-sibling corner (rotation surfaced, then
 *   declined), so either neighboring behavior is acceptable there.
 * A hintless marker falls back to the 60s default. The driver passes an abort
 * signal to the sleep, so a long (sub-threshold) hint stays interruptible.
 */
export function resolveRateLimitStallMs(
	failureMessage: string | undefined,
	stallRetriesUsed: number,
): number | undefined {
	if (failureMessage === undefined || stallRetriesUsed >= RATE_LIMIT_STALL_MAX_RETRIES) return undefined;
	const surfaced = parseSurfacedRateLimit(failureMessage);
	if (!surfaced) return undefined;
	const hint = surfaced.retryAfterMs ?? RATE_LIMIT_ROTATION_DEFAULT_MS;
	if (hint > RATE_LIMIT_STALL_DECLINE_ABOVE_MS) return undefined;
	return Math.max(RATE_LIMIT_STALL_MIN_SLEEP_MS, Math.round(hint));
}
