import { describe, expect, it } from "bun:test";
import {
	DEFAULT_JITTER_FRACTION,
	DEFAULT_LATENCY_P95_S,
	DEFAULT_MINIMUM_MARGIN_S,
	DEFAULT_WARM_FRACTION,
	leaseJitter,
	nextWarmDeadlineMs,
} from "../src/cache/lease";

describe("nextWarmDeadlineMs", () => {
	it("uses the warm fraction when the latency margin is not binding", () => {
		// Catches a margin clamp that fires unconditionally: with ttl 300 the margin
		// is max(10, 8) = 10, so min(240, 290) must resolve to the 240s fraction.
		const lastTouchAtMs = 1_000_000;
		expect(
			nextWarmDeadlineMs({
				lastTouchAtMs,
				ttlS: 300,
				warmFraction: 0.8,
				latencyP95S: 4,
				jitterFraction: 0,
				jitterKey: "fraction-branch",
			}),
		).toBe(lastTouchAtMs + 240_000);
	});

	it("clamps to ttl minus the latency margin when the fraction is too generous", () => {
		// Catches dropping the `ttlS - margin` term (or using latencyP95S without the
		// 2x round-trip factor): margin is max(10, 16) = 16, so min(285, 284) = 284.
		const lastTouchAtMs = 1_000_000;
		expect(
			nextWarmDeadlineMs({
				lastTouchAtMs,
				ttlS: 300,
				warmFraction: 0.95,
				latencyP95S: 8,
				jitterFraction: 0,
				jitterKey: "margin-branch",
			}),
		).toBe(lastTouchAtMs + 284_000);
	});

	it("keeps a jittered deadline inside the lease window at real wall-clock epochs", () => {
		// G1 regression. Failure mode: jitter multiplied into the absolute epoch
		// (`epoch * (1 + j)`) instead of the interval. At a real epoch a 3% spread is
		// ~1.7 years, so the deadline lands either far in the past (instantly due,
		// infinite warm loop) or far in the future (lease never refreshed).
		const lastTouchAtMs = Date.UTC(2026, 7, 25);
		const ttlS = 300;
		const deadline = nextWarmDeadlineMs({
			lastTouchAtMs,
			ttlS,
			jitterKey: "g1-regression",
		});

		const nominalOffsetMs = 240_000;
		expect(deadline).toBeGreaterThanOrEqual(lastTouchAtMs + nominalOffsetMs * 0.97);
		expect(deadline).toBeLessThanOrEqual(lastTouchAtMs + nominalOffsetMs * 1.03);
		expect(deadline).toBeGreaterThan(lastTouchAtMs);
		expect(deadline).toBeLessThan(lastTouchAtMs + ttlS * 1000);
	});

	it("never schedules in the past when the ttl is shorter than the margin", () => {
		// Catches a missing floor at 0: ttl 5 with a 10s margin gives a negative
		// offset, which would mark the lease permanently overdue.
		const lastTouchAtMs = Date.UTC(2026, 7, 25);
		const deadline = nextWarmDeadlineMs({
			lastTouchAtMs,
			ttlS: 5,
			jitterKey: "degenerate-ttl",
		});
		expect(deadline).toBeGreaterThanOrEqual(lastTouchAtMs);
		expect(deadline).toBeLessThan(lastTouchAtMs + 5_000);
	});

	it("applies the documented defaults when optional inputs are omitted", () => {
		// Catches default drift: the explicit-input form must reproduce the implicit
		// one exactly, so the exported constants are the real defaults.
		const lastTouchAtMs = Date.UTC(2026, 7, 25);
		const jitterKey = "defaults";
		expect(nextWarmDeadlineMs({ lastTouchAtMs, ttlS: 300, jitterKey })).toBe(
			nextWarmDeadlineMs({
				lastTouchAtMs,
				ttlS: 300,
				warmFraction: DEFAULT_WARM_FRACTION,
				minimumMarginS: DEFAULT_MINIMUM_MARGIN_S,
				latencyP95S: DEFAULT_LATENCY_P95_S,
				jitterFraction: DEFAULT_JITTER_FRACTION,
				jitterKey,
			}),
		);
	});
});

describe("leaseJitter", () => {
	it("is deterministic per key and spreads distinct keys apart", () => {
		// Failure mode: a random jitter would re-phase a lease on every scheduler
		// query, and a key-insensitive one would make every session warm in lockstep.
		expect(leaseJitter("lease-a", 0.03)).toBe(leaseJitter("lease-a", 0.03));
		expect(leaseJitter("lease-a", 0.03)).not.toBe(leaseJitter("lease-b", 0.03));
	});

	it("stays within the requested fraction for every sampled key", () => {
		// Catches a scale error (e.g. mapping to [-1, 1] or forgetting to centre the
		// unit value), which would push touches past expiry.
		const fraction = 0.03;
		const values = Array.from({ length: 64 }, (_, index) => leaseJitter(`lease-${index}`, fraction));
		for (const value of values) {
			expect(value).toBeGreaterThanOrEqual(-fraction);
			expect(value).toBeLessThanOrEqual(fraction);
		}
		// Non-vacuous: the sample must actually exercise both signs.
		expect(values.some(value => value > 0)).toBe(true);
		expect(values.some(value => value < 0)).toBe(true);
	});

	it("returns exactly positive zero for a zero fraction", () => {
		// Catches a `-0` leak: callers compare deadlines with Object.is semantics.
		expect(leaseJitter("lease-a", 0)).toBe(0);
		expect(leaseJitter("lease-b", 0)).toBe(0);
	});
});
