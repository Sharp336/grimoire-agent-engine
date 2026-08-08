import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { neuralwattUsageProvider } from "../src/usage/neuralwatt";

function quotaPayload(subscription: Record<string, unknown> | null): Record<string, unknown> {
	return { subscription };
}

const ACTIVE_SUBSCRIPTION: Record<string, unknown> = {
	plan: "pro",
	status: "active",
	kwh_used: 120.5,
	kwh_included: 500,
	kwh_remaining: 379.5,
	current_period_start: "2026-07-15T00:00:00Z",
	kwh_reset_date: "2026-08-15T00:00:00Z",
	in_overage: false,
};

function fakeFetch(payload: unknown, status = 200): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	return fn as unknown as typeof fetch;
}

function fetchRecorder(calls: Array<{ url: string; authorization?: string }>, payload: unknown): FetchImpl {
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			authorization: new Headers(init?.headers).get("Authorization") ?? undefined,
		});
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

function fetchUsage(payload: unknown, status = 200) {
	return neuralwattUsageProvider.fetchUsage(
		{ provider: "neuralwatt", credential: { type: "api_key", apiKey: "nw-test-key" } },
		{ fetch: fakeFetch(payload, status) },
	);
}

describe("neuralwatt usage provider", () => {
	it("normalizes the active subscription into a single kwh billing-period limit", async () => {
		const report = await fetchUsage(quotaPayload(ACTIVE_SUBSCRIPTION));

		expect(report).not.toBeNull();
		expect(report?.provider).toBe("neuralwatt");
		expect(report?.limits).toHaveLength(1);
		const limit = report?.limits[0];
		expect(limit?.id).toBe("neuralwatt:subscription");
		expect(limit?.scope).toMatchObject({ provider: "neuralwatt", tier: "pro", windowId: "billing", shared: true });
		expect(limit?.amount.used).toBe(120.5);
		expect(limit?.amount.limit).toBe(500);
		expect(limit?.amount.remaining).toBe(379.5);
		expect(limit?.amount.usedFraction).toBeCloseTo(120.5 / 500, 10);
		expect(limit?.amount.remainingFraction).toBeCloseTo(1 - 120.5 / 500, 10);
		expect(limit?.amount.unit).toBe("kwh");
		expect(limit?.status).toBe("ok");
		expect(limit?.window?.id).toBe("billing");
		expect(limit?.window?.resetsAt).toBe(Date.parse("2026-08-15T00:00:00Z"));
		expect(limit?.window?.durationMs).toBe(31 * 24 * 60 * 60 * 1000);
	});

	it("prefers kwh_reset_date over current_period_end for the reset timestamp", async () => {
		const report = await fetchUsage(
			quotaPayload({ ...ACTIVE_SUBSCRIPTION, current_period_end: "2026-08-16T00:00:00Z" }),
		);
		const limit = report?.limits[0];
		// The explicit kWh reset date wins when both fields are present.
		expect(limit?.window?.resetsAt).toBe(Date.parse("2026-08-15T00:00:00Z"));

		const fallback = await fetchUsage(
			quotaPayload({ ...ACTIVE_SUBSCRIPTION, kwh_reset_date: null, current_period_end: "2026-08-16T00:00:00Z" }),
		);
		expect(fallback?.limits[0]?.window?.resetsAt).toBe(Date.parse("2026-08-16T00:00:00Z"));
	});

	it("derives absolute and fractional usage from remaining when kwh_used is absent", async () => {
		const report = await fetchUsage(
			quotaPayload({ plan: "pro", kwh_included: 500, kwh_remaining: 100, kwh_reset_date: "2026-08-15T00:00:00Z" }),
		);
		const limit = report?.limits[0];
		expect(limit?.amount.used).toBe(400);
		expect(limit?.amount.usedFraction).toBeCloseTo(0.8, 10);
		expect(limit?.amount.remainingFraction).toBeCloseTo(0.2, 10);
	});

	it("keeps the account usable while in_overage: subscription warns and credit plus overage limits surface", async () => {
		// in_overage marks the included kWh as spent, but the account keeps
		// working off credits and overage capacity — routing must not treat the
		// subscription as blocked before the overage cap is hit.
		const report = await fetchUsage({
			subscription: { ...ACTIVE_SUBSCRIPTION, in_overage: true },
			balance: { credits_used_usd: 2.5, total_credits_usd: 10, credits_remaining_usd: 7.5 },
		});

		expect(report).not.toBeNull();
		expect(report?.limits.map(limit => limit.id)).toEqual([
			"neuralwatt:subscription",
			"neuralwatt:credits",
			"neuralwatt:overage",
		]);

		const subscription = report?.limits[0];
		expect(subscription?.status).toBe("warning");
		expect(subscription?.notes?.some(note => /overage/i.test(note))).toBe(true);

		const credits = report?.limits[1];
		expect(credits?.label).toBe("Credit Balance");
		expect(credits?.amount.limit).toBe(10);
		expect(credits?.amount.remaining).toBe(7.5);
		// Still 75% remaining: usable, not exhausted.
		expect(credits?.status).toBe("ok");

		const overage = report?.limits[2];
		expect(overage?.label).toBe("Overage Capacity");
		// No overage_limit_usd reported → the documented $100 default applies,
		// and the positive credit balance means none of it is spent yet.
		expect(overage?.amount.used).toBe(0);
		expect(overage?.amount.limit).toBe(100);
		expect(overage?.amount.remaining).toBe(100);
		expect(overage?.status).toBe("warning");

		// An explicit `null` cap resolves to the same $100 default as a missing one.
		const nullCap = await fetchUsage({
			subscription: { ...ACTIVE_SUBSCRIPTION, in_overage: true },
			balance: { credits_used_usd: 0, total_credits_usd: 0, credits_remaining_usd: -10 },
			limits: { overage_limit_usd: null },
		});
		const nullCapOverage = nullCap?.limits.find(limit => limit.id === "neuralwatt:overage");
		expect(nullCapOverage?.amount.limit).toBe(100);
		expect(nullCapOverage?.amount.remaining).toBe(90);
	});

	it("does not infer subscription overage from an exhausted kWh balance", async () => {
		const { in_overage: _inOverage, ...exhaustedSubscription } = ACTIVE_SUBSCRIPTION;
		const balance = { credits_used_usd: 2.5, total_credits_usd: 10, credits_remaining_usd: 7.5 };
		for (const subscription of [exhaustedSubscription, { ...exhaustedSubscription, in_overage: false }]) {
			const report = await fetchUsage({
				subscription: { ...subscription, kwh_used: 500, kwh_remaining: 0 },
				balance,
			});
			expect(report?.limits.map(limit => limit.id)).toEqual(["neuralwatt:subscription"]);
		}
	});

	it("uses the reported limits.overage_limit_usd as the overage cap instead of the $100 default", async () => {
		const report = await fetchUsage({
			subscription: { ...ACTIVE_SUBSCRIPTION, in_overage: true },
			balance: { credits_used_usd: 0, total_credits_usd: 0, credits_remaining_usd: -30 },
			limits: { overage_limit_usd: 50 },
		});

		const overage = report?.limits.find(limit => limit.id === "neuralwatt:overage");
		// $30 of negative balance against a custom $50 cap.
		expect(overage?.amount.used).toBe(30);
		expect(overage?.amount.limit).toBe(50);
		expect(overage?.amount.remaining).toBe(20);
		// Cap not yet reached: warning keeps the account routed, not exhausted.
		expect(overage?.status).toBe("warning");
	});

	it("exhausts overage only when the negative balance reaches the cap", async () => {
		const report = await fetchUsage({
			subscription: { ...ACTIVE_SUBSCRIPTION, in_overage: true },
			balance: { credits_used_usd: 0, total_credits_usd: 0, credits_remaining_usd: -100 },
		});

		const overage = report?.limits.find(limit => limit.id === "neuralwatt:overage");
		expect(overage?.amount.used).toBe(100);
		expect(overage?.amount.limit).toBe(100);
		expect(overage?.amount.remaining).toBe(0);
		expect(overage?.status).toBe("exhausted");
	});

	it("requests <baseUrl>/quota with a Bearer Authorization header", async () => {
		const calls: Array<{ url: string; authorization?: string }> = [];
		await neuralwattUsageProvider.fetchUsage(
			{ provider: "neuralwatt", credential: { type: "api_key", apiKey: "nw-test-key" } },
			{ fetch: fetchRecorder(calls, quotaPayload(ACTIVE_SUBSCRIPTION)) },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.neuralwatt.com/v1/quota");
		expect(calls[0]?.authorization).toBe("Bearer nw-test-key");

		const custom: Array<{ url: string; authorization?: string }> = [];
		await neuralwattUsageProvider.fetchUsage(
			{
				provider: "neuralwatt",
				credential: { type: "api_key", apiKey: "nw-test-key" },
				baseUrl: "https://neuralwatt.internal:8443/v1/",
			},
			{ fetch: fetchRecorder(custom, quotaPayload(ACTIVE_SUBSCRIPTION)) },
		);
		expect(custom[0]?.url).toBe("https://neuralwatt.internal:8443/v1/quota");
	});

	it("supports only api-key credentials for the neuralwatt provider", () => {
		expect(
			neuralwattUsageProvider.supports?.({
				provider: "neuralwatt",
				credential: { type: "api_key", apiKey: "nw-test-key" },
			}),
		).toBe(true);
		expect(
			neuralwattUsageProvider.supports?.({ provider: "zai", credential: { type: "api_key", apiKey: "x" } }),
		).toBe(false);
		expect(
			neuralwattUsageProvider.supports?.({
				provider: "neuralwatt",
				credential: { type: "oauth", accessToken: "x" },
			}),
		).toBe(false);
		expect(neuralwattUsageProvider.supports?.({ provider: "neuralwatt", credential: { type: "api_key" } })).toBe(
			false,
		);
	});

	it("returns null without contacting the endpoint for the wrong provider or credential type", async () => {
		let called = 0;
		const countingFetch: FetchImpl = (async () => {
			called += 1;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const wrongProvider = await neuralwattUsageProvider.fetchUsage(
			{ provider: "zai", credential: { type: "api_key", apiKey: "nw-test-key" } },
			{ fetch: countingFetch },
		);
		const wrongCredential = await neuralwattUsageProvider.fetchUsage(
			{ provider: "neuralwatt", credential: { type: "oauth", accessToken: "tok" } },
			{ fetch: countingFetch },
		);
		expect(wrongProvider).toBeNull();
		expect(wrongCredential).toBeNull();
		expect(called).toBe(0);
	});

	it("throws on a 401 auth failure so checkCredentials flags the bad key", async () => {
		await expect(fetchUsage({ message: "invalid api key" }, 401)).rejects.toThrow(/401/);
	});

	it("throws on a 403 auth failure so checkCredentials flags the bad key", async () => {
		await expect(fetchUsage({ message: "forbidden" }, 403)).rejects.toThrow(/403/);
	});

	it("returns null on a transient non-auth HTTP failure (500)", async () => {
		expect(await fetchUsage({ message: "internal server error" }, 500)).toBeNull();
	});

	it("returns null when the payload is malformed or carries no subscription", async () => {
		expect(await fetchUsage("not-an-object")).toBeNull();
		expect(await fetchUsage(quotaPayload(null))).toBeNull();
		expect(await fetchUsage(quotaPayload({ status: "none" }))).toBeNull();
	});

	it("returns null when no subscription, balance, or key allowance is surfaceable", async () => {
		// A balance/key present but carrying no usable numbers yields no limits.
		expect(await fetchUsage({ subscription: null, balance: {} })).toBeNull();
		expect(await fetchUsage({ subscription: null, key: { name: "x" } })).toBeNull();
		expect(await fetchUsage({ subscription: null, key: { allowance: {} } })).toBeNull();
		expect(await fetchUsage({ subscription: null, balance: {}, key: {} })).toBeNull();
	});

	it("returns null when the fetch itself fails (network error)", async () => {
		const failingFetch: FetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const report = await neuralwattUsageProvider.fetchUsage(
			{ provider: "neuralwatt", credential: { type: "api_key", apiKey: "nw-test-key" } },
			{ fetch: failingFetch },
		);
		expect(report).toBeNull();
	});

	describe("PAYG balance and per-key allowance", () => {
		it("normalizes a documented PAYG balance into a shared USD credits limit", async () => {
			const report = await fetchUsage({
				subscription: null,
				balance: {
					credits_used_usd: 12.34,
					total_credits_usd: 50,
					credits_remaining_usd: 37.66,
				},
			});

			expect(report).not.toBeNull();
			expect(report?.limits).toHaveLength(1);
			const limit = report?.limits[0];
			expect(limit?.id).toBe("neuralwatt:credits");
			expect(limit?.label).toBe("PAYG Credits");
			expect(limit?.scope).toMatchObject({ provider: "neuralwatt", shared: true });
			expect(limit?.amount.used).toBe(12.34);
			expect(limit?.amount.limit).toBe(50);
			expect(limit?.amount.remaining).toBe(37.66);
			expect(limit?.amount.unit).toBe("usd");
			expect(limit?.amount.usedFraction).toBeCloseTo(12.34 / 50, 10);
			expect(limit?.amount.remainingFraction).toBeCloseTo(1 - 12.34 / 50, 10);
			expect(limit?.status).toBe("ok");
		});

		it("marks a depleted PAYG balance exhausted when remaining credit reaches zero", async () => {
			const report = await fetchUsage({
				subscription: null,
				balance: { credits_used_usd: 50, total_credits_usd: 50, credits_remaining_usd: 0 },
			});
			const limit = report?.limits[0];
			expect(limit?.id).toBe("neuralwatt:credits");
			expect(limit?.amount.remaining).toBe(0);
			// remaining of 0 is exhausted even though the fraction math would also say so.
			expect(limit?.status).toBe("exhausted");
		});

		it("normalizes a per-key allowance with its reported period window", async () => {
			const report = await fetchUsage({
				subscription: null,
				key: {
					name: "ci-deploy",
					allowance: {
						spent_usd: 3.5,
						limit_usd: 10,
						remaining_usd: 6.5,
						period: "daily",
					},
				},
			});

			expect(report?.limits).toHaveLength(1);
			const limit = report?.limits[0];
			expect(limit?.id).toBe("neuralwatt:key-allowance");
			expect(limit?.label).toBe("API Key Allowance");
			expect(limit?.scope).toMatchObject({ provider: "neuralwatt", windowId: "daily", shared: true });
			expect(limit?.window).toMatchObject({ id: "daily", label: "Daily" });
			expect(limit?.amount.used).toBe(3.5);
			expect(limit?.amount.limit).toBe(10);
			expect(limit?.amount.remaining).toBe(6.5);
			expect(limit?.amount.unit).toBe("usd");
			expect(limit?.status).toBe("ok");
			// Key metadata is surfaced on the report.
			expect(report?.metadata?.keyName).toBe("ci-deploy");
		});

		it("marks a blocked key allowance exhausted even when spend is below the limit", async () => {
			const report = await fetchUsage({
				subscription: null,
				key: {
					allowance: { spent_usd: 1, limit_usd: 100, remaining_usd: 99, period: "monthly", blocked: true },
				},
			});
			const limit = report?.limits[0];
			expect(limit?.id).toBe("neuralwatt:key-allowance");
			// 1% used is still exhausted once the key is blocked.
			expect(limit?.status).toBe("exhausted");
			expect(limit?.notes?.some(note => /blocked/i.test(note))).toBe(true);
		});

		it("treats an unblocked key as warning, not exhausted, when the allowance remainder hits zero", async () => {
			// `blocked: true` is the only exhaustion signal for a key allowance. A
			// zero remainder without it means spend is at the cap but the key still
			// works — flagging it exhausted would route traffic away from a usable
			// credential.
			const report = await fetchUsage({
				subscription: null,
				key: { allowance: { spent_usd: 10, limit_usd: 10, remaining_usd: 0, period: "daily", blocked: false } },
			});
			const limit = report?.limits[0];
			expect(limit?.id).toBe("neuralwatt:key-allowance");
			expect(limit?.status).toBe("warning");
		});

		it("keeps the kWh subscription limit and drops the separate credit pool while retaining the key allowance", async () => {
			const report = await fetchUsage({
				subscription: ACTIVE_SUBSCRIPTION,
				balance: { credits_used_usd: 5, total_credits_usd: 25, credits_remaining_usd: 20 },
				key: { allowance: { spent_usd: 1, limit_usd: 10, remaining_usd: 9, period: "daily" } },
			});

			// Subscription is present, so the PAYG credit pool must NOT appear as a peer.
			expect(report?.limits).toHaveLength(2);
			const ids = report?.limits.map(l => l.id);
			expect(ids).toContain("neuralwatt:subscription");
			expect(ids).toContain("neuralwatt:key-allowance");
			expect(ids).not.toContain("neuralwatt:credits");
			// The subscription limit is still the kWh one.
			const sub = report?.limits.find(l => l.id === "neuralwatt:subscription");
			expect(sub?.amount.unit).toBe("kwh");
		});
	});
});
