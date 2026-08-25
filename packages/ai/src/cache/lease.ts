/**
 * Keepalive deadline scheduling for a single physical cache entry (a "lease").
 *
 * A lease knows one thing: given the moment the entry was last touched and how
 * long the provider is believed to retain it, when should the next keepalive
 * touch fire? Everything here is pure arithmetic so the scheduler that owns
 * timers can be tested without them.
 */

/** Fraction of the TTL after which a touch is scheduled, before margin clamping. */
export const DEFAULT_WARM_FRACTION = 0.8;
/** Floor on how far before expiry a touch must land, in seconds. */
export const DEFAULT_MINIMUM_MARGIN_S = 10;
/** Assumed p95 request latency in seconds when none has been observed yet. */
export const DEFAULT_LATENCY_P95_S = 4;
/** Spread applied to the warm interval so concurrent sessions do not stampede. */
export const DEFAULT_JITTER_FRACTION = 0.03;

export interface LeaseDeadlineInputs {
	lastTouchAtMs: number;
	ttlS: number;
	/** Observed p95 request latency in seconds. */
	latencyP95S?: number;
	warmFraction?: number;
	minimumMarginS?: number;
	jitterFraction?: number;
	/** Stable per-lease key (the cache fingerprint) used to derive deterministic jitter. */
	jitterKey: string;
}

/** Low 53 bits of a 64-bit hash: the widest slice a float64 holds exactly. */
const UNIT_MASK = 0x1f_ffff_ffff_ffffn;
const UNIT_SCALE = 2 ** 53;

/**
 * Deterministic value in `[-jitterFraction, +jitterFraction]` derived from
 * `jitterKey`.
 *
 * Deterministic rather than random so a lease keeps the same phase across
 * process restarts and across the several places that ask when it is due; keyed
 * on the fingerprint so distinct leases land at distinct instants instead of
 * every session in a fan-out warming in the same tick.
 */
export function leaseJitter(jitterKey: string, jitterFraction: number): number {
	// A zero (or nonsensical) spread must return exactly +0, never -0: callers
	// compare deadlines for equality, and Object.is(-0, 0) is false.
	if (!(jitterFraction > 0)) return 0;
	// Take the low 53 bits so the BigInt->Number conversion is lossless: casting
	// the full 64-bit value would silently round away the low bits (and make
	// neighbouring hashes collide onto the same jitter).
	const unit = Number(Bun.hash.xxHash64(jitterKey) & UNIT_MASK) / UNIT_SCALE;
	return (unit * 2 - 1) * jitterFraction;
}

/**
 * Epoch ms at which a keepalive touch should fire, or `undefined` when this lease has
 * no useful deadline.
 *
 * `undefined` means the TTL cannot clear the round-trip margin (`ttlS <= marginS`), so
 * a touch issued at any instant would arrive after the entry is already gone. That is
 * reachable from a supplied policy TTL and from a learned profile that observed early
 * eviction. Clamping the offset to 0 instead would place the deadline at
 * `lastTouchAtMs`, i.e. permanently due: a caller that reschedules after every touch
 * would spin a zero-delay timer forever, burning the keepalive budget without ever
 * buying coverage.
 */
export function nextWarmDeadlineMs(inputs: LeaseDeadlineInputs): number | undefined {
	const {
		lastTouchAtMs,
		ttlS,
		latencyP95S = DEFAULT_LATENCY_P95_S,
		warmFraction = DEFAULT_WARM_FRACTION,
		minimumMarginS = DEFAULT_MINIMUM_MARGIN_S,
		jitterFraction = DEFAULT_JITTER_FRACTION,
		jitterKey,
	} = inputs;

	// The touch itself takes a round trip, so it must be issued far enough before
	// expiry that a p95-slow request still arrives while the entry is alive.
	const marginS = Math.max(minimumMarginS, latencyP95S * 2);
	const safeOffsetS = Math.min(ttlS * warmFraction, ttlS - marginS);
	// `!(x > 0)` rather than `x <= 0` so a non-finite TTL is refused too.
	if (!(safeOffsetS > 0)) return undefined;

	// Jitter multiplies the *interval*, never the absolute epoch. Upstream
	// cachepilot computed `safeDeadlineEpoch * (1 + jitter)`; against a real
	// wall-clock epoch (~1.77e9 s) a 3% spread displaced deadlines by ±1.7 years,
	// so every lease was either already overdue or unreachably far in the future.
	return lastTouchAtMs + safeOffsetS * (1 + leaseJitter(jitterKey, jitterFraction)) * 1000;
}
