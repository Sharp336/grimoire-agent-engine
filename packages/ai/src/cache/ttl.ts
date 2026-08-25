/**
 * Evidence-based TTL learning for provider prefix caches.
 *
 * No provider documents its real retention behaviour precisely enough to schedule
 * a keepalive against it, and the documented number is an upper bound anyway
 * (eviction under pressure is invisible). So the effective lifetime is learned
 * from observations: a confirmed hit after A idle seconds *proves* the entry
 * survived A seconds, and a rebuilt miss after B idle seconds *proves* it was
 * gone by B. Repeated observations squeeze the true TTL into `[lower, upper]`.
 *
 * Everything here is pure: fold observations in with {@link observeTtl} and keep
 * the returned profile. The aggregation key for a profile is
 * `routeProfileKey(...)`, never a full cache fingerprint — a profile describes a
 * route's retention behaviour, not one conversation's entry.
 */

import type { CacheOutcome } from "./types";

/** Learned lifetime evidence for one route/retention pair. */
export interface TtlProfile {
	/** Largest idle age at which the entry was proven alive. */
	lowerBoundS?: number;
	/** Smallest idle age at which the entry was proven dead. */
	upperBoundS?: number;
	/** Cached {@link estimateTtl} result, recomputed on every observation. */
	estimateS?: number;
	/** Trust in the estimate; starts at 0.5 and is clamped to `[0.05, 0.95]`. */
	confidence: number;
	/** Number of *evidence-bearing* observations folded in. */
	sampleCount: number;
}

/**
 * Where inside the proven-alive/proven-dead interval the estimate sits.
 *
 * Deliberately biased low (35%, not 50%): the two errors are not symmetric.
 * Warming early only costs one extra cache-read-priced touch, while warming late
 * loses the whole entry and forces a full cold rebuild at write/input rates.
 */
export const TTL_ESTIMATE_INTERVAL_FRACTION = 0.35;

/** Confidence starts here: no evidence either way. */
export const TTL_INITIAL_CONFIDENCE = 0.5;
export const TTL_CONFIDENCE_MIN = 0.05;
export const TTL_CONFIDENCE_MAX = 0.95;

/** A confirmed hit is the strongest evidence: it moves the lower bound up. */
export const TTL_CONFIDENCE_DELTA_HIT = 0.05;
/** A rebuilt miss is weaker: the entry may have been evicted early under pressure. */
export const TTL_CONFIDENCE_DELTA_MISS = 0.02;
/** A success we could not verify tells us the model of this route is drifting. */
export const TTL_CONFIDENCE_DELTA_UNVERIFIED = -0.05;
/** New evidence contradicting the opposite bound: the learned interval was wrong. */
export const TTL_CONFIDENCE_DELTA_INCONSISTENT = -0.05;

/** Confidence at or above this, with enough samples, lets the learned TTL win. */
const TTL_LEARNED_CONFIDENCE_GATE = 0.7;
const TTL_DEFAULT_MINIMUM_SAMPLES = 3;

export function emptyTtlProfile(): TtlProfile {
	return { confidence: TTL_INITIAL_CONFIDENCE, sampleCount: 0 };
}

/**
 * Fold one observation into a profile. Returns a NEW profile; never mutates the
 * input, so a caller may keep the prior profile for comparison or rollback.
 *
 * `failed` is never evidence — a transport error says nothing about retention —
 * and neither is an observation without a usable (non-negative) `idleSeconds`.
 *
 * `success-unverified` lowers confidence but MUST NOT increment `sampleCount`.
 * That is upstream cachepilot bug G14c: it counted unverified successes as
 * samples, so a route that never reports cache tokens accumulated enough
 * "samples" to satisfy the resolver's gate while holding zero actual evidence,
 * and the keepalive then scheduled against a fabricated TTL.
 */
export function observeTtl(profile: TtlProfile, touch: { outcome: CacheOutcome; idleSeconds?: number }): TtlProfile {
	if (touch.outcome === "failed") return profile;

	const next: TtlProfile = {
		lowerBoundS: profile.lowerBoundS,
		upperBoundS: profile.upperBoundS,
		estimateS: profile.estimateS,
		confidence: profile.confidence,
		sampleCount: profile.sampleCount,
	};

	if (touch.outcome === "success-unverified") {
		next.confidence = clampConfidence(profile.confidence + TTL_CONFIDENCE_DELTA_UNVERIFIED);
		return next;
	}

	const idleSeconds = touch.idleSeconds;
	// A missing or negative idle age cannot move a bound, so it is not evidence.
	if (idleSeconds === undefined || !Number.isFinite(idleSeconds) || idleSeconds < 0) return next;

	let contradicted = false;
	if (touch.outcome === "confirmed-hit") {
		// Proven alive at `idleSeconds`.
		next.lowerBoundS = Math.max(profile.lowerBoundS ?? 0, idleSeconds);
		if (profile.upperBoundS !== undefined && idleSeconds >= profile.upperBoundS) {
			// We previously believed the entry was dead by then. The live observation
			// is the newer, stronger fact: drop the stale ceiling rather than keep an
			// inverted interval that would make the estimate meaningless.
			contradicted = true;
			next.upperBoundS = undefined;
		}
	} else {
		// `miss-rebuilt`: proven dead by `idleSeconds`.
		next.upperBoundS = profile.upperBoundS === undefined ? idleSeconds : Math.min(profile.upperBoundS, idleSeconds);
		if (profile.lowerBoundS !== undefined && idleSeconds <= profile.lowerBoundS) {
			contradicted = true;
			next.lowerBoundS = undefined;
		}
	}

	const delta = contradicted
		? TTL_CONFIDENCE_DELTA_INCONSISTENT
		: touch.outcome === "confirmed-hit"
			? TTL_CONFIDENCE_DELTA_HIT
			: TTL_CONFIDENCE_DELTA_MISS;
	next.confidence = clampConfidence(profile.confidence + delta);
	next.sampleCount = profile.sampleCount + 1;
	next.estimateS = estimateTtl(next);
	return next;
}

/**
 * Best current guess at the usable lifetime, or `undefined` when there is nothing
 * to base one on — an unknown TTL is reported as unknown and never guessed at.
 */
export function estimateTtl(profile: TtlProfile, hintS?: number): number | undefined {
	const lower = profile.lowerBoundS;
	const upper = profile.upperBoundS;
	if (upper !== undefined) {
		const floor = lower ?? 0;
		return floor + (upper - floor) * TTL_ESTIMATE_INTERVAL_FRACTION;
	}
	if (hintS === undefined && lower === undefined) return undefined;
	return Math.max(hintS ?? 0, lower ?? 0);
}

/**
 * Pick the TTL to schedule against, reporting which tier won so callers can
 * explain a keepalive decision instead of asserting one.
 */
export function resolveTtl(args: {
	profile?: TtlProfile;
	forceS?: number;
	hintS?: number;
	defaultS: number;
	minimumSamples?: number;
}): { ttlS: number; confidence: number; source: "force" | "learned" | "hint" | "default" } {
	if (args.forceS !== undefined && args.forceS > 0) {
		return { ttlS: args.forceS, confidence: 1, source: "force" };
	}

	const profile = args.profile;
	const minimumSamples = args.minimumSamples ?? TTL_DEFAULT_MINIMUM_SAMPLES;
	if (
		profile !== undefined &&
		profile.confidence >= TTL_LEARNED_CONFIDENCE_GATE &&
		profile.sampleCount >= minimumSamples
	) {
		const learned = estimateTtl(profile, args.hintS);
		if (learned !== undefined && learned > 0) {
			return { ttlS: learned, confidence: profile.confidence, source: "learned" };
		}
	}

	if (args.hintS !== undefined && args.hintS > 0) {
		// A provider-declared retention is a documented ceiling, not an observation.
		return { ttlS: args.hintS, confidence: TTL_INITIAL_CONFIDENCE, source: "hint" };
	}
	return { ttlS: args.defaultS, confidence: TTL_CONFIDENCE_MIN, source: "default" };
}

function clampConfidence(value: number): number {
	return Math.min(TTL_CONFIDENCE_MAX, Math.max(TTL_CONFIDENCE_MIN, value));
}
