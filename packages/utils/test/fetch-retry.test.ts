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
	// Zhipu Coding Plan 429 type=1308; the bare stamp is server UTC+8 wall clock.
	const ZHIPU_1308 = "429 已达到 5 小时的使用上限。您的限额将在 2026-08-17 11:17:40 重置。 (type=1308)";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("converts the Zhipu 1308 reset stamp into a delta plus grace", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z")); // 08:00 Beijing
		// 11:17:40 Beijing = 03:17:40Z → 17m40s + 3s grace.
		expect(extractRetryHint(undefined, ZHIPU_1308)).toBe(17 * 60_000 + 40_000 + 3_000);
	});

	// International Z.AI 1308 JSON; the unmarked stamp is Singapore wall clock (UTC+8).
	it("reads the unmarked Z.AI 1308 English stamp as UTC+8", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(
				undefined,
				'{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-08-17 11:17:40"}',
			),
		).toBe(17 * 60_000 + 40_000 + 3_000);
	});

	it('reads the documented {"error":{code,message}} envelope as UTC+8', () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(
				undefined,
				'{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-08-17 11:17:40"}}',
			),
		).toBe(17 * 60_000 + 40_000 + 3_000);
	});

	it("keeps a quoted code that is not paired with its message key off the absolute path", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(undefined, '{"code":"1308","detail":"Your limit will reset at 2026-08-17 11:17:40"}'),
		).toBeUndefined();
		expect(
			extractRetryHint(undefined, '{"code":1308,"message":"Your limit will reset at 2026-08-17 11:17:40"}'),
		).toBeUndefined();
	});

	it("rejects a code riding another code's documented message", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(
				undefined,
				'{"code":"1308","message":"Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-08-17 11:17:40"}',
			),
		).toBeUndefined();
		expect(
			extractRetryHint(undefined, "已达到 5 小时的使用上限。您的限额将在 2026-08-17 11:17:40 重置。 (type=1310)"),
		).toBeUndefined();
	});

	it("honors the documented 1316 and 1318 messages", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(
				undefined,
				'{"code":"1316","message":"Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-08-17 11:17:40."}',
			),
		).toBe(17 * 60_000 + 40_000 + 3_000);
		expect(
			extractRetryHint(
				undefined,
				'{"code":"1318","message":"已达到 5 小时使用上限，且已达子账号月消费上限，无法使用超额按量付费。您的限额将在 2026-08-17 11:17:40 重置。"}',
			),
		).toBe(17 * 60_000 + 40_000 + 3_000);
	});

	it("keeps an ungated English stamp off the absolute path so relative hints apply", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(extractRetryHint(undefined, "Your limit will reset at 2026-08-17 11:17:40. Please retry in 5s")).toBe(
			5_000,
		);
	});

	// 1310 is weekly/monthly: a monthly reset can sit weeks past a single-week horizon.
	it("honors a monthly reset stamp weeks out (code 1310)", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(undefined, "您已达到每周/每月使用上限，您的限额将在 2026-09-06 11:00:00 重置 (type=1310)"),
		).toBe(20 * 24 * 3_600_000 + 3_000);
	});

	// Past in both reads (~8h43m as UTC+8, ~42m reread as UTC) → garbage either way.
	it("ignores a past stamp instead of inventing a wait", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T12:00:00Z"));
		expect(extractRetryHint(undefined, ZHIPU_1308)).toBeUndefined();
	});

	it("rereads a long-stale bare stamp as UTC", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T06:30:00Z"));
		// 11:17:40Z is 4h47m40s out; +3s grace.
		expect(extractRetryHint(undefined, ZHIPU_1308)).toBe(4 * 3_600_000 + 47 * 60_000 + 40_000 + 3_000);
	});

	it("does not reread a stamp past the code's horizon as UTC", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T00:00:00Z"));
		expect(
			extractRetryHint(undefined, "您已达到每周/每月使用上限，您的限额将在 2026-08-17 11:17:40 重置 (type=1310)"),
		).toBeUndefined();
	});

	it("never rereads a zoned stamp", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T12:00:00Z"));
		expect(
			extractRetryHint(undefined, "已达到 5 小时的使用上限。您的限额将在 2026-08-17 03:17:40Z 重置。 (type=1308)"),
		).toBeUndefined();
	});

	it("ignores a reset stated beyond the 31-day horizon", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(undefined, "您已达到每周/每月使用上限，您的限额将在 2026-12-31 11:17:40 重置 (type=1310)"),
		).toBeUndefined();
	});

	it("honors an explicit zone marker over the assumed UTC+8", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T03:00:00Z"));
		expect(
			extractRetryHint(
				undefined,
				"已达到 5 小时的使用上限。您的限额将在 2026-08-17 03:17:40+00:00 重置。 (type=1308)",
			),
		).toBe(17 * 60_000 + 40_000 + 3_000);
		// Lowercase marker on a 1317 body so the wait sits inside its 7-day window.
		expect(
			extractRetryHint(
				undefined,
				'{"code":"1317","message":"Usage limit reached for the past 7 days. Insufficient balance for extra usage. Resets at 2026-08-17 11:17:40 z"}',
			),
		).toBe(8 * 3_600_000 + 17 * 60_000 + 40_000 + 3_000);
	});

	it("ignores an impossible day instead of letting it roll into the next month", () => {
		expect(
			extractRetryHint(undefined, "已达到 5 小时的使用上限。您的限额将在 2026-02-30 11:17:40 重置。 (type=1308)"),
		).toBeUndefined();
	});

	it("ignores a datetime not bracketed by reset wording", () => {
		expect(extractRetryHint(undefined, "订阅有效期至 2026-08-17 11:17:40")).toBeUndefined();
	});

	it("falls back to relative hints when the stamp yields no wait target", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-17T12:00:00Z"));
		expect(extractRetryHint(undefined, `${ZHIPU_1308} Please retry in 5s`)).toBe(5_000);
	});
});
