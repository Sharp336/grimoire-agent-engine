/**
 * Contracts for cache-outcome classification: the precedence between the ordered
 * rules, and the refusal to infer a hit from a successful response.
 */

import { describe, expect, it } from "bun:test";
import { classifyCacheOutcome, classifyTouchOutcome, MIN_CACHE_FOOTPRINT } from "@oh-my-pi/pi-ai/cache/outcome";

describe("classifyCacheOutcome", () => {
	it("reports a confirmed hit when cache tokens were read", () => {
		expect(classifyCacheOutcome({ ok: true, cacheRead: 4096, cacheWrite: 0, inputTokens: 120 })).toBe(
			"confirmed-hit",
		);
	});

	it("reports a rebuilt miss when only cache tokens were written", () => {
		expect(classifyCacheOutcome({ ok: true, cacheRead: 0, cacheWrite: 4096, inputTokens: 120 })).toBe("miss-rebuilt");
	});

	it("reports success-unverified when the provider reports neither bucket", () => {
		// Implicit-caching providers report no cache tokens at all. HTTP 200 is not
		// evidence of a hit, and calling it one is how a cache optimizer starts lying.
		expect(classifyCacheOutcome({ ok: true, cacheRead: 0, cacheWrite: 0, inputTokens: 120 })).toBe(
			"success-unverified",
		);
	});

	it("reports failed when the request did not succeed", () => {
		expect(classifyCacheOutcome({ ok: false, cacheRead: 0, cacheWrite: 0, inputTokens: 120 })).toBe("failed");
	});

	it("prefers a read over a simultaneous write", () => {
		// Extending a warm prefix writes the tail while reading the head; that is still
		// proof of reuse, and downgrading it to a miss would erase real hit evidence.
		expect(classifyCacheOutcome({ ok: true, cacheRead: 4096, cacheWrite: 512, inputTokens: 8192 })).toBe(
			"confirmed-hit",
		);
	});

	it("prefers failure over any reported cache usage", () => {
		// A failed request observed nothing, whatever usage the partial response carried.
		expect(classifyCacheOutcome({ ok: false, cacheRead: 4096, cacheWrite: 512, inputTokens: 8192 })).toBe("failed");
	});

	it("does not gate classification on MIN_CACHE_FOOTPRINT", () => {
		// A large zero/zero prompt is surprising, but surprise is not verification:
		// both sides of the footprint floor must classify identically.
		const large = classifyCacheOutcome({
			ok: true,
			cacheRead: 0,
			cacheWrite: 0,
			inputTokens: MIN_CACHE_FOOTPRINT * 50,
		});
		const small = classifyCacheOutcome({
			ok: true,
			cacheRead: 0,
			cacheWrite: 0,
			inputTokens: MIN_CACHE_FOOTPRINT - 1,
		});
		expect(large).toBe("success-unverified");
		expect(small).toBe("success-unverified");
	});
});

describe("classifyTouchOutcome", () => {
	it("calls a touch that wrote cache a rebuilt miss, even alongside a read", () => {
		// THE difference from `classifyCacheOutcome`, and the reason a second function
		// exists. A touch replays a request that was already sent, so it extends nothing: a
		// write means the entry it was holding open had expired and this replay rebuilt it,
		// perhaps only partly. Filing that as a hit teaches `observeTtl` that the route
		// survives an interval it demonstrably did not, and later leases are then scheduled
		// past the real expiry.
		expect(classifyTouchOutcome({ ok: true, cacheRead: 4096, cacheWrite: 512 })).toBe("miss-rebuilt");
		// Same counters, ordinary request: still a hit, because there the write is just the
		// conversation's tail being appended past the prefix that was read.
		expect(classifyCacheOutcome({ ok: true, cacheRead: 4096, cacheWrite: 512, inputTokens: 8192 })).toBe(
			"confirmed-hit",
		);
	});

	it("agrees with the chain's own verified-touch rule", () => {
		// `CacheKeepaliveTouchResult.verified` is `cacheRead > 0 && cacheWrite === 0`, and
		// telemetry that contradicts the control flow it describes is worse than none: only
		// that exact shape may be reported as a hit.
		expect(classifyTouchOutcome({ ok: true, cacheRead: 4096, cacheWrite: 0 })).toBe("confirmed-hit");
		expect(classifyTouchOutcome({ ok: true, cacheRead: 0, cacheWrite: 4096 })).toBe("miss-rebuilt");
		expect(classifyTouchOutcome({ ok: true, cacheRead: 0, cacheWrite: 0 })).toBe("success-unverified");
	});

	it("prefers failure over any reported cache usage", () => {
		expect(classifyTouchOutcome({ ok: false, cacheRead: 4096, cacheWrite: 0 })).toBe("failed");
	});
});
