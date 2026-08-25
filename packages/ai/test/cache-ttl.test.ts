import { describe, expect, it } from "bun:test";
import {
	emptyTtlProfile,
	estimateTtl,
	observeTtl,
	resolveTtl,
	TTL_ESTIMATE_INTERVAL_FRACTION,
	type TtlProfile,
} from "../src/cache/ttl";

describe("observeTtl", () => {
	it("narrows the interval from a hit then a miss and biases the estimate low", () => {
		// Catches a learner that keeps only the latest observation, or that centres the
		// estimate in the interval and so schedules keepalives after the entry died.
		const afterHit = observeTtl(emptyTtlProfile(), { outcome: "confirmed-hit", idleSeconds: 180 });
		const afterMiss = observeTtl(afterHit, { outcome: "miss-rebuilt", idleSeconds: 300 });

		expect(afterMiss.lowerBoundS).toBeGreaterThanOrEqual(180);
		expect(afterMiss.upperBoundS).toBeLessThanOrEqual(300);
		expect(afterMiss.sampleCount).toBe(2);
		expect(estimateTtl(afterMiss)).toBeCloseTo(180 + 120 * TTL_ESTIMATE_INTERVAL_FRACTION, 6);
		expect(estimateTtl(afterMiss)).toBeCloseTo(222, 6);
		// The cached estimate must agree with the pure function.
		expect(afterMiss.estimateS).toBeCloseTo(222, 6);
	});

	it("does not mutate the profile it is given", () => {
		// Catches an in-place fold, which would corrupt a shared profile map and make
		// any before/after comparison silently vacuous.
		const profile: TtlProfile = { confidence: 0.5, sampleCount: 1, lowerBoundS: 60 };
		const snapshot = structuredClone(profile);

		observeTtl(profile, { outcome: "miss-rebuilt", idleSeconds: 240 });

		expect(profile).toEqual(snapshot);
	});

	it("never counts success-unverified as a sample (G14c)", () => {
		// Upstream cachepilot incremented sampleCount here, so a route that reports no
		// cache tokens could satisfy the resolver's sample gate with zero evidence.
		let profile = emptyTtlProfile();
		for (let i = 0; i < 5; i++) {
			profile = observeTtl(profile, { outcome: "success-unverified", idleSeconds: 120 });
		}

		expect(profile.sampleCount).toBe(0);
		expect(profile.confidence).toBeLessThan(0.5);
		expect(profile.lowerBoundS).toBeUndefined();
		expect(profile.upperBoundS).toBeUndefined();
		expect(resolveTtl({ profile, defaultS: 300, minimumSamples: 3 }).source).not.toBe("learned");
	});

	it("treats a failed request as no evidence at all", () => {
		// Catches a learner that reads a transport failure as an eviction and collapses
		// the upper bound to the current idle age.
		const profile: TtlProfile = {
			confidence: 0.62,
			sampleCount: 4,
			lowerBoundS: 120,
			upperBoundS: 400,
			estimateS: 218,
		};

		expect(observeTtl(profile, { outcome: "failed", idleSeconds: 90 })).toEqual(profile);
	});

	it("ignores a missing or negative idle age without counting a sample", () => {
		// Catches `idleSeconds ?? 0`, which would pin the lower bound at 0 and inflate
		// sampleCount toward the resolver's gate.
		const base: TtlProfile = { confidence: 0.5, sampleCount: 2, lowerBoundS: 100 };

		const noIdle = observeTtl(base, { outcome: "confirmed-hit" });
		const negative = observeTtl(base, { outcome: "miss-rebuilt", idleSeconds: -5 });

		expect(noIdle.sampleCount).toBe(2);
		expect(noIdle.lowerBoundS).toBe(100);
		expect(negative.sampleCount).toBe(2);
		expect(negative.upperBoundS).toBeUndefined();
	});

	it("saturates confidence at 0.95 and floors it at 0.05", () => {
		// Catches unclamped accumulation, which would let a long-lived route reach
		// certainty (or zero) and stop responding to new evidence.
		let high = emptyTtlProfile();
		for (let i = 0; i < 40; i++) {
			high = observeTtl(high, { outcome: "confirmed-hit", idleSeconds: 100 + i });
		}
		expect(high.confidence).toBe(0.95);

		let low = emptyTtlProfile();
		for (let i = 0; i < 40; i++) {
			low = observeTtl(low, { outcome: "success-unverified" });
		}
		expect(low.confidence).toBe(0.05);
	});

	it("applies the negative delta when a hit contradicts the known upper bound", () => {
		// Catches unconditional credit for a hit: evidence that the learned ceiling was
		// wrong must reduce trust, not reinforce it.
		const profile: TtlProfile = { confidence: 0.5, sampleCount: 3, upperBoundS: 300 };

		const contradicting = observeTtl(profile, { outcome: "confirmed-hit", idleSeconds: 400 });
		const agreeing = observeTtl(profile, { outcome: "confirmed-hit", idleSeconds: 200 });

		expect(contradicting.confidence).toBeCloseTo(0.45, 6);
		expect(agreeing.confidence).toBeCloseTo(0.55, 6);
		expect(contradicting.lowerBoundS).toBe(400);
		// The stale ceiling is dropped rather than kept as an inverted interval.
		expect(contradicting.upperBoundS).toBeUndefined();
		expect(estimateTtl(contradicting)).toBe(400);
	});
});

describe("estimateTtl", () => {
	it("returns undefined with no evidence and no hint, and the hint when only a hint exists", () => {
		// Catches a fabricated default: an unknown TTL must be reported as unknown so the
		// caller falls back deliberately instead of scheduling against a guess.
		expect(estimateTtl(emptyTtlProfile())).toBeUndefined();
		expect(estimateTtl(emptyTtlProfile(), 300)).toBe(300);
		expect(estimateTtl({ confidence: 0.5, sampleCount: 1, lowerBoundS: 420 }, 300)).toBe(420);
	});
});

describe("resolveTtl", () => {
	const learnable: TtlProfile = {
		confidence: 0.9,
		sampleCount: 4,
		lowerBoundS: 180,
		upperBoundS: 300,
	};

	it("prefers force over a confident learned profile", () => {
		expect(resolveTtl({ profile: learnable, forceS: 60, hintS: 300, defaultS: 300 })).toEqual({
			ttlS: 60,
			confidence: 1,
			source: "force",
		});
	});

	it("uses the learned estimate once confidence and samples both clear the gate", () => {
		const resolved = resolveTtl({ profile: learnable, hintS: 300, defaultS: 300 });
		expect(resolved.source).toBe("learned");
		expect(resolved.ttlS).toBeCloseTo(222, 6);
		expect(resolved.confidence).toBe(0.9);
	});

	it("falls through learned when confidence is high but samples are too few", () => {
		// Catches a gate that ORs the two conditions: one lucky observation must not
		// override the provider hint.
		const resolved = resolveTtl({
			profile: { ...learnable, sampleCount: 1 },
			hintS: 300,
			defaultS: 900,
		});
		expect(resolved.source).toBe("hint");
		expect(resolved.ttlS).toBe(300);
	});

	it("falls back to the default when there is no profile and no hint", () => {
		const resolved = resolveTtl({ defaultS: 300 });
		expect(resolved.source).toBe("default");
		expect(resolved.ttlS).toBe(300);
	});
});
