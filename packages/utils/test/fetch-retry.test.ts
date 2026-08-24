import { afterEach, describe, expect, it, vi } from "bun:test";
import { extractRetryHint, fetchWithRetry } from "@oh-my-pi/pi-utils/fetch-retry";

describe("fetchWithRetry", () => {
	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("lets callers stop retries for deterministic response bodies", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		const response = await fetchWithRetry("https://example.invalid/z", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => !bodyText.includes("deterministic"),
		});

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("deterministic provider failure");
		expect(attempt).toBe(1);
	});

	it("returns retryable responses immediately when retry hints exceed the delay cap", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/rate-limit", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});

	it("normalizes aborts during response backoff", async () => {
		const request = fetchWithRetry("https://example.invalid/response-backoff", {
			fetch: async () => new Response("retry", { status: 503 }),
			signal: AbortSignal.timeout(10),
			defaultDelayMs: 1_000,
			maxAttempts: 2,
		});

		await expect(request).rejects.toMatchObject({
			name: "Error",
			message: "Request was aborted",
		});
	});

	it("normalizes aborts during network-error backoff", async () => {
		const request = fetchWithRetry("https://example.invalid/network-backoff", {
			fetch: async () => {
				throw new TypeError("connection reset");
			},
			signal: AbortSignal.timeout(10),
			defaultDelayMs: 1_000,
			maxAttempts: 2,
		});

		await expect(request).rejects.toMatchObject({
			name: "Error",
			message: "Request was aborted",
		});
	});
});

describe("extractRetryHint", () => {
	// Devin returns HTTP 403 with "Your limit will reset in 13 minutes" for an
	// account-scoped message rate cap. Without recognizing "will reset in", the
	// credential is blocked for the 1-minute default instead of 13 minutes and
	// can be reselected and hammered while the cap remains active.
	it("parses Devin 'Your limit will reset in 13 minutes' as 13 minutes", () => {
		expect(extractRetryHint(undefined, "Your limit will reset in 13 minutes")).toBe(13 * 60_000);
	});

	it("parses bare 'reset in 13 minutes' phrasing", () => {
		expect(extractRetryHint(undefined, "reset in 13 minutes")).toBe(13 * 60_000);
	});

	it("parses 'will reset in 2h' phrasing", () => {
		expect(extractRetryHint(undefined, "will reset in 2h")).toBe(2 * 60 * 60_000);
	});

	// A quota body can carry both a generic retry hint and the account reset
	// window ("Please retry in 5s. Your limit will reset in 13 minutes"). The
	// account-reset hint must take precedence so the exhausted credential stays
	// blocked for the full stated window instead of the short generic retry.
	it("prefers the account reset window over a shorter retry hint", () => {
		expect(extractRetryHint(undefined, "Please retry in 5s. Your limit will reset in 13 minutes")).toBe(13 * 60_000);
	});
});

describe("extractRetryHint — absolute reset timestamps", () => {
	// Zhipu Coding Plan 429 type=1308 body. The stamp carries no zone marker;
	// it is Beijing wall-clock time (the domestic console's own clock).
	const ZHIPU_1308 = "429 已达到 5 小时的使用上限。您的限额将在 2026-08-17 11:17:40 重置。 (type=1308)";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("converts the Zhipu 1308 reset stamp into a delta plus grace", () => {
		const nowMs = Date.parse("2026-08-17T03:00:00Z"); // 08:00 Beijing
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		// 11:17:40 Beijing = 03:17:40Z → 17m40s + 3s grace.
		expect(extractRetryHint(undefined, ZHIPU_1308)).toBe(17 * 60_000 + 40_000 + 3_000);
	});

	// International Z.AI 1308 JSON body (quoted verbatim in the wild); its
	// unmarked stamp is Singapore wall-clock (UTC+8, same offset as Beijing).
	it("reads the unmarked Z.AI 1308 English stamp as UTC+8", () => {
		const nowMs = Date.parse("2026-08-17T03:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		expect(
			extractRetryHint(
				undefined,
				'{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-08-17 11:17:40"}',
			),
		).toBe(17 * 60_000 + 40_000 + 3_000);
	});

	it("ignores a stamp whose UTC reread is still past", () => {
		// now = 12:00Z: the +08:00 reading is 8h42m stale and its UTC reread
		// (-42m) is still past — no defensible wait target either way, so the
		// stamp yields nothing instead of parking the session.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T12:00:00Z"));
		expect(extractRetryHint(undefined, ZHIPU_1308)).toBeUndefined();
	});

	it("rereads a long-stale stamp as UTC per Zhipu support guidance", () => {
		// now = 04:00Z. The stamp read as +08:00 is 03:17:40Z — 42m20s stale,
		// far past the 1m plausibility window, so the server likely returned
		// UTC: reread gives 11:17:40Z, 7h17m40s out (+3s grace).
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T04:00:00Z"));
		expect(extractRetryHint(undefined, ZHIPU_1308)).toBe(7 * 3_600_000 + 17 * 60_000 + 40_000 + 3_000);
	});

	it("retries a just-past stamp once the boundary is a full window past", () => {
		// now = 03:18:20Z, only 40s past the +08:00 reading — a plausible
		// just-reset boundary, not evidence of a UTC server: waiting 8h (the
		// reread) would overshoot a boundary that may have just taken. Retry
		// at boundary + 60s window + 3s grace = 23s from now.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:18:20Z"));
		expect(extractRetryHint(undefined, ZHIPU_1308)).toBe(-40_000 + 60_000 + 3_000);
	});

	it("honors an explicit zone marker over the assumed UTC+8", () => {
		// A stamp carrying its own zone is read as-is; no attested body has
		// one yet, this covers Zhipu stamping it in later. +00:00 reading is
		// 03:17:40Z (17m40s + 3s grace) — the assumed +08:00 would say 8h17m.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(extractRetryHint(undefined, "您的限额将在 2026-08-17 03:17:40+00:00 重置。")).toBe(
			17 * 60_000 + 40_000 + 3_000,
		);
	});

	it("does not reread a stale stamp that carries its own zone", () => {
		// now = 12:00Z: the explicit-Z stamp is 8h42m in the past. The UTC
		// reread exists only to correct an assumed zone; there is nothing to
		// correct here, so the stamp yields nothing.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T12:00:00Z"));
		expect(extractRetryHint(undefined, "您的限额将在 2026-08-17 03:17:40Z 重置。")).toBeUndefined();
	});

	it("ignores stamps beyond the sanity horizon", () => {
		const nowMs = Date.parse("2026-08-17T03:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		expect(extractRetryHint(undefined, "您的限额将在 2027-12-31 11:17:40 重置")).toBeUndefined();
	});

	it("ignores a datetime not bracketed by reset wording", () => {
		expect(extractRetryHint(undefined, "订阅有效期至 2026-08-17 11:17:40")).toBeUndefined();
	});

	it("ignores an out-of-calendar datetime rather than rolling over", () => {
		expect(extractRetryHint(undefined, "您的限额将在 2026-13-17 11:17:40 重置")).toBeUndefined();
	});
	it("falls back to relative hints when the stamp yields no wait target", () => {
		// The bracketed stamp outranks the generic hint only when it yields a
		// wait; here its reread is still past, so the 5s hint applies.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T12:00:00Z"));
		expect(extractRetryHint(undefined, `${ZHIPU_1308} Please retry in 5s`)).toBe(5_000);
	});
});
