import { describe, expect, it } from "bun:test";
import { type FetchRetrySleepInfo, fetchWithRetry } from "@oh-my-pi/pi-utils/fetch-retry";

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

	it("consults onBeforeSleep before the over-cap early-return and surfaces the over-cap 429", async () => {
		let attempt = 0;
		const seen: FetchRetrySleepInfo[] = [];
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/over-cap-surface", {
			fetch: customFetch,
			maxAttempts: 3,
			maxDelayMs: 10,
			onBeforeSleep: info => {
				seen.push(info);
				return "surface";
			},
		});

		// The strongest rotation case: an over-cap hint must reach the hook and be
		// surfaceable instead of silently returning without consulting it.
		expect(response.status).toBe(429);
		expect(attempt).toBe(1);
		expect(seen).toHaveLength(1);
		// delayMs is the capped value; retryHintMs carries the raw over-cap hint.
		// willSleep is false: a "sleep" decision would hit the over-cap fail-fast
		// return, so no sleep would actually happen.
		expect(seen[0]).toMatchObject({ delayMs: 10, retryHintMs: 3_600_000, willSleep: false });
	});

	it("returns the over-cap 429 without sleeping when onBeforeSleep declines (baseline give-up)", async () => {
		let attempt = 0;
		const decisions: string[] = [];
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/over-cap-sleep", {
			fetch: customFetch,
			maxAttempts: 3,
			maxDelayMs: 10,
			onBeforeSleep: () => {
				decisions.push("sleep");
				return "sleep";
			},
		});

		// Hook declined → the over-cap early-return still fires: the response is
		// returned without sleeping (no retry, no refetch).
		expect(response.status).toBe(429);
		expect(attempt).toBe(1);
		expect(decisions).toEqual(["sleep"]);
	});

	it("returns the over-cap 429 with no hook (byte-identical over-cap baseline)", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/over-cap-baseline", {
			fetch: customFetch,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		// No hook: the over-cap hint returns the response immediately, unchanged.
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});

	it("passes the classified sleep context to onBeforeSleep and surfaces the response on demand", async () => {
		let attempt = 0;
		const seen: FetchRetrySleepInfo[] = [];
		const customFetch = async () => {
			attempt += 1;
			return new Response("too many requests", { status: 429, headers: { "Retry-After": "30" } });
		};

		const response = await fetchWithRetry("https://example.invalid/surface", {
			fetch: customFetch,
			maxAttempts: 3,
			onBeforeSleep: info => {
				seen.push(info);
				return "surface";
			},
		});

		// Surfacing returns the current non-ok response without sleeping or refetching.
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("too many requests");
		expect(attempt).toBe(1);
		expect(seen).toHaveLength(1);
		// willSleep is true: a mid-run, in-cap attempt would really sleep delayMs.
		expect(seen[0]).toMatchObject({
			bodyText: "too many requests",
			attempt: 0,
			delayMs: 30_000,
			retryHintMs: 30_000,
			willSleep: true,
		});
		expect(seen[0]?.response.status).toBe(429);
	});

	it("keeps the normal backoff when onBeforeSleep returns sleep", async () => {
		let attempt = 0;
		const decisions: string[] = [];
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
			return new Response("recovered", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/sleep", {
			fetch: customFetch,
			maxAttempts: 3,
			onBeforeSleep: () => {
				decisions.push("sleep");
				return "sleep";
			},
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("recovered");
		expect(attempt).toBe(2);
		expect(decisions).toEqual(["sleep"]);
	});

	it("keeps the pre-hook retry behavior byte-identical when no hook is provided", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
			return new Response("recovered", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/baseline", {
			fetch: customFetch,
			maxAttempts: 3,
		});

		// Baseline pin: a transient 429 sleeps its hint and recovers on retry.
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("recovered");
		expect(attempt).toBe(2);
	});

	it("consults the surface gate on the final attempt so a terminal 429 stays surfaceable", async () => {
		let attempt = 0;
		const seen: FetchRetrySleepInfo[] = [];
		const customFetch = async () => {
			attempt += 1;
			return new Response("too many requests", { status: 429, headers: { "Retry-After": "30" } });
		};

		// maxAttempts: 1 → the very first attempt is the final one. The pre-fix
		// early-return skipped the hook here, degrading a rotatable 429 to a plain
		// terminal 429; now the gate is consulted (exactly once) so it can mark the
		// response surfaced for the caller's marker rewrite.
		const response = await fetchWithRetry("https://example.invalid/final-surface", {
			fetch: customFetch,
			maxAttempts: 1,
			onBeforeSleep: info => {
				seen.push(info);
				return "surface";
			},
		});

		expect(response.status).toBe(429);
		expect(attempt).toBe(1);
		expect(seen).toHaveLength(1);
		// willSleep is false: the final attempt returns right after the hook, so a
		// "sleep" decision would not actually sleep.
		expect(seen[0]).toMatchObject({ attempt: 0, delayMs: 30_000, retryHintMs: 30_000, willSleep: false });
		expect(seen[0]?.response.status).toBe(429);
	});

	it("returns the response on a final-attempt sleep decision without retrying (consulted once)", async () => {
		let attempt = 0;
		const decisions: string[] = [];
		const customFetch = async () => {
			attempt += 1;
			return new Response("too many requests", { status: 429, headers: { "Retry-After": "30" } });
		};

		// A "sleep" decision on the final attempt has no sleep to preserve — the
		// response is returned as-is. The point of consulting is only to let the
		// gate observe the attempt; there is no second consultation or refetch.
		const response = await fetchWithRetry("https://example.invalid/final-sleep", {
			fetch: customFetch,
			maxAttempts: 1,
			onBeforeSleep: () => {
				decisions.push("sleep");
				return "sleep";
			},
		});

		expect(response.status).toBe(429);
		expect(attempt).toBe(1);
		expect(decisions).toEqual(["sleep"]);
	});

	it("does not consult the surface gate on the final attempt when shouldRetryResponse declines", async () => {
		let attempt = 0;
		const gateCalls: FetchRetrySleepInfo[] = [];
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		// The retry predicate owns retryability: a response it declines must be
		// returned as-is on the final attempt too, never handed to `onBeforeSleep`
		// for surfacing.
		const response = await fetchWithRetry("https://example.invalid/final-decline", {
			fetch: customFetch,
			maxAttempts: 1,
			shouldRetryResponse: () => false,
			onBeforeSleep: info => {
				gateCalls.push(info);
				return "surface";
			},
		});

		expect(response.status).toBe(500);
		expect(attempt).toBe(1);
		expect(gateCalls).toEqual([]);
		expect(await response.text()).toBe("deterministic provider failure");
	});

	it("does not read the body on the final attempt when no hook is provided (byte-identical baseline)", async () => {
		let cloneCalls = 0;
		const customFetch = async () => {
			const resp = new Response("busy", { status: 429, headers: { "Retry-After": "30" } });
			const realClone = resp.clone.bind(resp);
			// `fetchWithRetry` reads the retry body via `response.clone().text()`. On the
			// no-hook final attempt it must return before touching the body at all.
			resp.clone = () => {
				cloneCalls += 1;
				return realClone();
			};
			return resp;
		};

		const response = await fetchWithRetry("https://example.invalid/final-no-hook", {
			fetch: customFetch,
			maxAttempts: 1,
		});

		expect(response.status).toBe(429);
		expect(cloneCalls).toBe(0);
		expect(await response.text()).toBe("busy");
	});
});
