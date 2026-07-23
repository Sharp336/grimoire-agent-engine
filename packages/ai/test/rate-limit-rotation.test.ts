/**
 * Contract: the surfaced-rate-limit marker (`rate-limit-rotation.ts`) is the
 * single formatter/parser pair the transports and the auth-retry driver
 * communicate through. The marker bytes are parsed downstream
 * (`parseSurfacedRateLimit`, `isSurfacedRateLimitMessage`), so the exact
 * string is pinned; composed messages must classify as RATE_LIMIT_EXCEEDED
 * (never usage-limit, never opaque) unless the base itself carries quota text.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	clampRateLimitRotationMs,
	createRateLimitSurfaceGate,
	formatSurfacedRateLimitMessage,
	isSurfacedRateLimitMessage,
	parseSurfacedRateLimit,
	RATE_LIMIT_STALL_MAX_RETRIES,
	type RateLimitRotationOptions,
	resolveRateLimitStallMs,
	toSurfacedRateLimitError,
	waitBeforeProviderRetry,
	warnRateLimitStall,
} from "@oh-my-pi/pi-ai";
import { OpenAIHttpError } from "@oh-my-pi/pi-ai/error";
import {
	isOpaqueStatusBody,
	isUsageLimitOutcome,
	matchesUsageLimitText,
	parseRateLimitReason,
} from "@oh-my-pi/pi-ai/error/rate-limit";
import { logger } from "@oh-my-pi/pi-utils";
import type { FetchRetrySleepInfo } from "@oh-my-pi/pi-utils/fetch-retry";

afterEach(() => {
	vi.restoreAllMocks();
});

function rotation(overrides?: Partial<RateLimitRotationOptions>): RateLimitRotationOptions {
	return {
		enabled: true,
		provider: "test-provider",
		minSleepMs: 2_000,
		hasUsableSibling: () => true,
		...overrides,
	};
}

function sleepInfo(overrides?: Partial<FetchRetrySleepInfo>): FetchRetrySleepInfo {
	return {
		response: new Response("", { status: 429 }),
		bodyText: "429 Too many requests",
		attempt: 0,
		delayMs: 30_000,
		retryHintMs: 30_000,
		willSleep: true,
		...overrides,
	};
}

describe("surfaced rate-limit marker contract", () => {
	it("formats the pinned marker bytes with and without a retry hint", () => {
		// Downstream code regexes these exact bytes — pin them.
		expect(formatSurfacedRateLimitMessage("429 Too many requests", 12_000)).toBe(
			"429 Too many requests; rate limit surfaced for rotation; retry-after-ms: 12000ms",
		);
		expect(formatSurfacedRateLimitMessage("429 Too many requests", undefined)).toBe(
			"429 Too many requests; rate limit surfaced for rotation",
		);
		// Fractional/negative hints normalize to a non-negative integer.
		expect(formatSurfacedRateLimitMessage("x", 1500.4)).toBe(
			"x; rate limit surfaced for rotation; retry-after-ms: 1500ms",
		);
		expect(formatSurfacedRateLimitMessage("x", -5)).toBe("x; rate limit surfaced for rotation; retry-after-ms: 0ms");
	});

	it("round-trips through the parser", () => {
		const withHint = formatSurfacedRateLimitMessage("429 Too many requests", 12_000);
		expect(parseSurfacedRateLimit(withHint)).toEqual({ retryAfterMs: 12_000 });
		expect(isSurfacedRateLimitMessage(withHint)).toBe(true);

		const withoutHint = formatSurfacedRateLimitMessage("429 Too many requests", undefined);
		expect(parseSurfacedRateLimit(withoutHint)).toEqual({ retryAfterMs: undefined });
		expect(isSurfacedRateLimitMessage(withoutHint)).toBe(true);

		expect(parseSurfacedRateLimit("429 Too many requests")).toBeUndefined();
		expect(isSurfacedRateLimitMessage("429 Too many requests")).toBe(false);
	});

	it("composed messages classify as transient RATE_LIMIT_EXCEEDED, never usage-limit or opaque", () => {
		const composed = formatSurfacedRateLimitMessage("429 Too many requests", 12_000);
		expect(parseRateLimitReason(composed)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, composed)).toBe(false);
		expect(isOpaqueStatusBody(composed)).toBe(false);
		// Even an empty base cannot make the composed message opaque.
		expect(isOpaqueStatusBody(formatSurfacedRateLimitMessage("", undefined))).toBe(false);
	});

	it("marker retry-after hints never collide with numeric status classification", () => {
		// Two collision classes the `ms`-suffixed hint format must defeat:
		//  - digits that EMBED a status (5030 → "503", 5290 → "529", 15000 → "500");
		//  - a hint whose value IS EXACTLY a status (503/529/500) — before the `ms`
		//    suffix these sat between two word boundaries and `\b503\b` matched.
		// A raw-substring or boundary classifier would reclassify the composed
		// message as MODEL_CAPACITY/SERVER_ERROR; the `ms` suffix keeps the
		// module's invariant that a marker message is always transient.
		for (const retryAfterMs of [500, 503, 529, 5030, 5290, 15000]) {
			const composed = formatSurfacedRateLimitMessage("429 Too many requests", retryAfterMs);
			expect(parseRateLimitReason(composed)).toBe("RATE_LIMIT_EXCEEDED");
			expect(isUsageLimitOutcome(429, composed)).toBe(false);
		}
	});

	it("keeps quota bases on the usage-limit path (quota wins over the marker)", () => {
		const quotaComposed = formatSurfacedRateLimitMessage(
			"429 insufficient_quota: You exceeded your current quota",
			12_000,
		);
		expect(matchesUsageLimitText(quotaComposed)).toBe(true);
		expect(isUsageLimitOutcome(429, quotaComposed)).toBe(true);
	});

	it("mutates the message in place so subclass fields survive the rewrite", () => {
		const error = new OpenAIHttpError(
			"429 Too many requests",
			{ status: 429, headers: new Headers(), bodyText: "{}", bodyJson: {} },
			"rate_limit_error",
		);
		const surfaced = toSurfacedRateLimitError(error, 30_000);
		// Same instance: `captured`/`code` consumed by strict-tools fallback survive.
		expect(surfaced).toBe(error);
		expect(surfaced.message).toBe("429 Too many requests; rate limit surfaced for rotation; retry-after-ms: 30000ms");
		expect(surfaced.status).toBe(429);
		expect((surfaced as OpenAIHttpError).code).toBe("rate_limit_error");
	});
});

describe("clampRateLimitRotationMs", () => {
	it("clamps into [5s, 120s] with a 60s default", () => {
		expect(clampRateLimitRotationMs(undefined)).toBe(60_000);
		expect(clampRateLimitRotationMs(1_000)).toBe(5_000);
		expect(clampRateLimitRotationMs(999_999)).toBe(120_000);
		expect(clampRateLimitRotationMs(30_000)).toBe(30_000);
		// Boundary pins: zero and negative hints clamp to the 5s floor (not the
		// 60s default — those are a real, present hint of 0, not "no hint").
		expect(clampRateLimitRotationMs(0)).toBe(5_000);
		expect(clampRateLimitRotationMs(-5)).toBe(5_000);
	});

	it("round-trips a retryAfterMs: 0 marker to a floored block duration", () => {
		// The formatter emits `retry-after-ms: 0ms`; the parser must read it back as
		// the number 0 (the string "0" is truthy, so a naive `match[1] ? ...` keeps
		// it) — pin it so nobody "fixes" the parser into dropping a present 0 hint.
		const marker = formatSurfacedRateLimitMessage("429 Too many requests", 0);
		const surfaced = parseSurfacedRateLimit(marker);
		expect(surfaced).toEqual({ retryAfterMs: 0 });
		expect(clampRateLimitRotationMs(surfaced?.retryAfterMs)).toBe(5_000);
	});
});

describe("createRateLimitSurfaceGate", () => {
	it("surfaces a RATE_LIMIT_EXCEEDED 429 with a sibling and a long-enough sleep", async () => {
		const gate = createRateLimitSurfaceGate(rotation());
		await expect(gate.onBeforeSleep(sleepInfo())).resolves.toBe("surface");
		expect(gate.surfaced).toBe(true);
		expect(gate.surfacedRetryAfterMs).toBe(30_000);
	});

	it("prefers the raw server hint but falls back to the capped delay", async () => {
		const gate = createRateLimitSurfaceGate(rotation());
		await gate.onBeforeSleep(sleepInfo({ retryHintMs: undefined, delayMs: 25_000 }));
		expect(gate.surfacedRetryAfterMs).toBe(25_000);
	});

	it("surfaces an over-cap hint and carries the raw (uncapped) retry-after into the marker", async () => {
		// fetchWithRetry now consults the gate before its over-cap early-return, so
		// delayMs is the capped value while retryHintMs is the raw over-cap hint.
		const gate = createRateLimitSurfaceGate(rotation());
		await expect(gate.onBeforeSleep(sleepInfo({ delayMs: 60_000, retryHintMs: 3_600_000 }))).resolves.toBe("surface");
		expect(gate.surfaced).toBe(true);
		expect(gate.surfacedRetryAfterMs).toBe(3_600_000);
	});

	it("sleeps on non-RATE_LIMIT body classifications (UNKNOWN / capacity / quota / empty)", async () => {
		for (const bodyText of [
			"Please retry shortly", // UNKNOWN
			"Service overloaded", // MODEL_CAPACITY_EXHAUSTED
			"You exceeded your current quota", // QUOTA_EXHAUSTED
			"", // empty
		]) {
			const sibling = vi.fn(() => true);
			const gate = createRateLimitSurfaceGate(rotation({ hasUsableSibling: sibling }));
			await expect(gate.onBeforeSleep(sleepInfo({ bodyText }))).resolves.toBe("sleep");
			expect(gate.surfaced).toBe(false);
			// Body classification gates BEFORE the sibling probe fires.
			expect(sibling).not.toHaveBeenCalled();
		}
	});

	it("sleeps on non-429 statuses and when disabled", async () => {
		const gate = createRateLimitSurfaceGate(rotation());
		await expect(gate.onBeforeSleep(sleepInfo({ response: new Response("", { status: 503 }) }))).resolves.toBe(
			"sleep",
		);
		const disabled = createRateLimitSurfaceGate(rotation({ enabled: false }));
		await expect(disabled.onBeforeSleep(sleepInfo())).resolves.toBe("sleep");
	});

	it("sleeps when the pending delay is below minSleepMs", async () => {
		const gate = createRateLimitSurfaceGate(rotation({ minSleepMs: 2_000 }));
		await expect(gate.onBeforeSleep(sleepInfo({ delayMs: 1_999 }))).resolves.toBe("sleep");
		expect(gate.surfaced).toBe(false);
	});

	it("sleeps when no sibling exists or the sibling probe throws", async () => {
		const noSibling = createRateLimitSurfaceGate(rotation({ hasUsableSibling: () => false }));
		await expect(noSibling.onBeforeSleep(sleepInfo())).resolves.toBe("sleep");
		const throwing = createRateLimitSurfaceGate(
			rotation({
				hasUsableSibling: () => {
					throw new Error("probe failed");
				},
			}),
		);
		await expect(throwing.onBeforeSleep(sleepInfo())).resolves.toBe("sleep");
		expect(throwing.surfaced).toBe(false);
	});

	it("warns the no-sibling stall at most once across repeated attempts", async () => {
		// fetchWithRetry re-enters the gate on every retry attempt; one logical
		// stall must not spam N duplicate `rate_limit_stall` logs.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const gate = createRateLimitSurfaceGate(rotation({ hasUsableSibling: () => false }));
		for (let attempt = 0; attempt < 4; attempt++) {
			await expect(gate.onBeforeSleep(sleepInfo({ attempt }))).resolves.toBe("sleep");
		}
		expect(warn.mock.calls.filter(call => call[0] === "rate_limit_stall")).toHaveLength(1);
	});

	it("does not warn a phantom no-sibling stall when fetchWithRetry will not actually sleep", async () => {
		// Final-attempt and over-cap "sleep" decisions return immediately; a warn
		// there would claim a 60s stall for a request that failed fast in ms. The
		// non-sleep call must also leave the latch unspent for a later real stall.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const gate = createRateLimitSurfaceGate(rotation({ hasUsableSibling: () => false }));
		await expect(gate.onBeforeSleep(sleepInfo({ willSleep: false }))).resolves.toBe("sleep");
		expect(warn).not.toHaveBeenCalledWith("rate_limit_stall", expect.anything());
		await expect(gate.onBeforeSleep(sleepInfo({ attempt: 1 }))).resolves.toBe("sleep");
		expect(warn.mock.calls.filter(call => call[0] === "rate_limit_stall")).toHaveLength(1);
	});

	it("warns a below-minSleep stall of at least 10s (symmetry with the provider-retry seam)", async () => {
		// Contract: an un-rotated rate-limit sleep >= 10s warns, on BOTH seams. A
		// configured minSleepMs above the warn threshold must not make a 12s
		// un-rotated sleep silent here while the anthropic path warns it.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const gate = createRateLimitSurfaceGate(rotation({ minSleepMs: 15_000 }));
		await expect(gate.onBeforeSleep(sleepInfo({ delayMs: 12_000, retryHintMs: 12_000 }))).resolves.toBe("sleep");
		expect(gate.surfaced).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			"rate_limit_stall",
			expect.objectContaining({ provider: "test-provider", delayMs: 12_000, source: "fetch-retry" }),
		);
		// Same shape without a real sleep behind it stays silent.
		const phantom = createRateLimitSurfaceGate(rotation({ minSleepMs: 15_000 }));
		warn.mockClear();
		await expect(
			phantom.onBeforeSleep(sleepInfo({ delayMs: 12_000, retryHintMs: 12_000, willSleep: false })),
		).resolves.toBe("sleep");
		expect(warn).not.toHaveBeenCalledWith("rate_limit_stall", expect.anything());
	});
});

describe("waitBeforeProviderRetry", () => {
	it("delegates to providerRetryWait with the cause when no rotation is configured", async () => {
		const providerRetryWait = vi.fn(async () => {});
		const cause = new Error("some transient failure");
		const signal = new AbortController().signal;
		await waitBeforeProviderRetry(1_234, { signal, providerRetryWait }, cause);
		expect(providerRetryWait).toHaveBeenCalledWith(1_234, signal, cause);
	});

	it("throws the ORIGINAL cause with the pinned marker message for a long transient-429 sleep with a sibling", async () => {
		const providerRetryWait = vi.fn(async () => {});
		const cause = Object.assign(new Error("429 Too many requests"), { status: 429 });
		let caught: unknown;
		try {
			await waitBeforeProviderRetry(30_000, { providerRetryWait, rateLimitRotation: rotation() }, cause);
		} catch (error) {
			caught = error;
		}
		// Identity: the cause is rewritten in place and rethrown — never wrapped in
		// a fresh ProviderHttpError that would drop subclass fields/headers.
		expect(caught).toBe(cause);
		expect((caught as { status: number }).status).toBe(429);
		expect((caught as Error).message).toBe(
			"429 Too many requests; rate limit surfaced for rotation; retry-after-ms: 30000ms",
		);
		expect(providerRetryWait).not.toHaveBeenCalled();
	});

	it("does not throw for non-RATE_LIMIT bodies, short sleeps, or missing siblings", async () => {
		const providerRetryWait = vi.fn(async () => {});
		const unknownBody = Object.assign(new Error("429 Please try again shortly"), { status: 429 });
		await waitBeforeProviderRetry(30_000, { providerRetryWait, rateLimitRotation: rotation() }, unknownBody);

		const rateLimited = Object.assign(new Error("429 Too many requests"), { status: 429 });
		await waitBeforeProviderRetry(
			1_000,
			{ providerRetryWait, rateLimitRotation: rotation({ minSleepMs: 2_000 }) },
			rateLimited,
		);
		await waitBeforeProviderRetry(
			30_000,
			{ providerRetryWait, rateLimitRotation: rotation({ hasUsableSibling: () => false }) },
			rateLimited,
		);
		expect(providerRetryWait).toHaveBeenCalledTimes(3);
	});
});

describe("warnRateLimitStall", () => {
	it("logs only for stalls of at least 10s", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		warnRateLimitStall({ provider: "p", delayMs: 9_999, source: "fetch-retry" });
		expect(warn).not.toHaveBeenCalled();
		warnRateLimitStall({ provider: "p", delayMs: 10_000, source: "fetch-retry", attempt: 2 });
		expect(warn).toHaveBeenCalledWith("rate_limit_stall", {
			provider: "p",
			delayMs: 10_000,
			source: "fetch-retry",
			attempt: 2,
		});
	});

	it("warns once per shared latch; below-threshold sleeps never consume it", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const once = { warned: false };
		// A below-threshold sleep is a no-op and leaves the latch unspent.
		warnRateLimitStall({ provider: "p", delayMs: 9_999, source: "provider-retry" }, once);
		expect(once.warned).toBe(false);
		// The first qualifying stall logs and latches; further ones stay silent.
		warnRateLimitStall({ provider: "p", delayMs: 30_000, source: "provider-retry" }, once);
		warnRateLimitStall({ provider: "p", delayMs: 30_000, source: "provider-retry" }, once);
		expect(warn.mock.calls.filter(call => call[0] === "rate_limit_stall")).toHaveLength(1);
		expect(once.warned).toBe(true);
	});
});

describe("resolveRateLimitStallMs", () => {
	it("honors the full server hint for marker failures and declines everything else", () => {
		const marker = formatSurfacedRateLimitMessage("429 Too many requests", 12_000);
		expect(resolveRateLimitStallMs(marker, 0)).toBe(12_000);
		// The stall sleep honors the FULL retry-after — an over-the-block-cap hint
		// (300s) must NOT be truncated to the 120s block window, or the driver
		// re-attempts the same key early and burns the stall budget on a repeat 429.
		expect(resolveRateLimitStallMs(formatSurfacedRateLimitMessage("429 x", 300_000), 0)).toBe(300_000);
		// Never-truncate holds up to the 10-minute decline threshold (inclusive).
		expect(resolveRateLimitStallMs(formatSurfacedRateLimitMessage("429 x", 600_000), 0)).toBe(600_000);
		// Above the threshold the stall DECLINES (undefined → terminal 429 for the
		// outer retry/fallback layers) instead of truncating: a truncated sleep
		// re-attempts into a guaranteed 429, while an unbounded sleep would hold
		// the request ~15min where the rotation-off baseline fails fast.
		expect(resolveRateLimitStallMs(formatSurfacedRateLimitMessage("429 x", 900_000), 0)).toBeUndefined();
		// Sub-floor hint clamps up; missing hint uses the 60s default.
		expect(resolveRateLimitStallMs(formatSurfacedRateLimitMessage("429 x", 1_000), 0)).toBe(5_000);
		// A PRESENT zero hint takes the ?? branch and clamps to the 5s floor —
		// it must NOT fall through to the 60s no-hint default (a ??→|| regression
		// would conflate `0` with "absent" and fail here).
		expect(resolveRateLimitStallMs(formatSurfacedRateLimitMessage("429 x", 0), 0)).toBe(5_000);
		expect(resolveRateLimitStallMs(formatSurfacedRateLimitMessage("429 x", undefined), 0)).toBe(60_000);
		expect(resolveRateLimitStallMs("429 Too many requests", 0)).toBeUndefined();
		expect(resolveRateLimitStallMs(undefined, 0)).toBeUndefined();
		expect(resolveRateLimitStallMs(marker, RATE_LIMIT_STALL_MAX_RETRIES)).toBeUndefined();
	});
});
