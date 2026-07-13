import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams, UsageLogger } from "@oh-my-pi/pi-ai/usage";
import { minimaxCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/minimax-code";

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "sk-cp-test",
	};
}

function silentLogger(): UsageLogger {
	return {
		debug: () => {},
		warn: () => {},
	};
}

interface CapturedRequest {
	url: string;
	init: RequestInit;
}

function makeCtx(payload: unknown, captures: CapturedRequest[] = []): UsageFetchContext {
	const fetchImpl: FetchImpl = async (input, init) => {
		captures.push({ url: String(input), init: init ?? {} });
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fetchImpl, logger: silentLogger() };
}

function makeErroringCtx(status: number, body: unknown = {}): UsageFetchContext {
	const fetchImpl: FetchImpl = async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	return { fetch: fetchImpl };
}

function okBaseResp() {
	return { base_resp: { status_code: 0, status_msg: "success" } };
}

function modelRemain(args: {
	model_name: string;
	fiveHour: { total: number; remaining: number; endTime: number };
	weekly: { total: number; remaining: number; endTime: number; startTime: number };
	fiveHourPercent?: number;
	weeklyPercent?: number;
	fiveHourStatus?: number;
	weeklyStatus?: number;
}) {
	const out: Record<string, unknown> = {
		start_time: args.fiveHour.endTime - 5 * 60 * 60 * 1000,
		end_time: args.fiveHour.endTime,
		remains_time: 60_000,
		current_interval_total_count: args.fiveHour.total,
		current_interval_usage_count: args.fiveHour.remaining,
		model_name: args.model_name,
		current_weekly_total_count: args.weekly.total,
		current_weekly_usage_count: args.weekly.remaining,
		weekly_start_time: args.weekly.startTime,
		weekly_end_time: args.weekly.endTime,
		weekly_remains_time: 60_000,
		current_interval_status: args.fiveHourStatus ?? 1,
		current_interval_remaining_percent: args.fiveHourPercent ?? 100,
		current_weekly_status: args.weeklyStatus ?? 1,
		current_weekly_remaining_percent: args.weeklyPercent ?? 100,
	};
	return out;
}

describe("minimax-code usage provider", () => {
	it("ignores non-general products (e.g. video) and emits one UsageLimit pair per general row", async () => {
		const report = await minimaxCodeUsageProvider.fetchUsage!(
			{ provider: "minimax-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				...okBaseResp(),
				model_remains: [
					modelRemain({
						model_name: "general",
						fiveHour: { total: 500, remaining: 480, endTime: 1783382400000 },
						weekly: { total: 10000, remaining: 8000, startTime: 1783296000000, endTime: 1783900800000 },
						fiveHourStatus: 1,
						weeklyStatus: 1,
					}),
					modelRemain({
						model_name: "video",
						fiveHour: { total: 100, remaining: 10, endTime: 1783382400000 },
						weekly: { total: 2000, remaining: 1500, startTime: 1783296000000, endTime: 1783900800000 },
						fiveHourStatus: 1,
						weeklyStatus: 1,
					}),
				],
			}),
		);

		expect(report).not.toBeNull();
		// Only the general row is surfaced; video is filtered out.
		const ids = report!.limits.map(limit => limit.id).sort();
		expect(ids).toEqual(["minimax-code:5h:general", "minimax-code:weekly:general"]);
		expect(ids.some(id => id.includes("video"))).toBe(false);

		const general5h = report!.limits.find(limit => limit.id === "minimax-code:5h:general");
		expect(general5h?.amount).toEqual({
			unit: "requests",
			limit: 500,
			remaining: 480,
			used: 20,
			usedFraction: 20 / 500,
			remainingFraction: 480 / 500,
		});
		expect(general5h?.window?.resetsAt).toBe(1783382400000);
		expect(general5h?.status).toBe("ok");
	});

	it("treats *_status: 3 as unlimited (Coding Plan tier) — uses percent as a hint, surfaces note", async () => {
		const report = await minimaxCodeUsageProvider.fetchUsage!(
			{ provider: "minimax-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				...okBaseResp(),
				model_remains: [
					modelRemain({
						model_name: "general",
						fiveHour: { total: 0, remaining: 0, endTime: 1783382400000 },
						weekly: { total: 0, remaining: 0, startTime: 1783296000000, endTime: 1783900800000 },
						fiveHourPercent: 83,
						weeklyPercent: 100,
						fiveHourStatus: 1, // capped 5h
						weeklyStatus: 3, // unlimited weekly
					}),
				],
			}),
		);

		expect(report).not.toBeNull();

		// general / 5h: status=1, percent=83 → trust the percent
		const general5h = report!.limits.find(limit => limit.id === "minimax-code:5h:general");
		expect(general5h?.amount.usedFraction).toBeCloseTo(0.17, 5);
		expect(general5h?.amount.remainingFraction).toBeCloseTo(0.83, 5);
		expect(general5h?.status).toBe("ok");
		expect(general5h?.notes).toBeUndefined();

		// general / weekly: status=3 → unlimited
		const generalWeekly = report!.limits.find(limit => limit.id === "minimax-code:weekly:general");
		expect(generalWeekly?.status).toBe("ok");
		expect(generalWeekly?.notes).toEqual(["Unlimited on this window — see Coding Plan."]);
		expect(generalWeekly?.amount.usedFraction).toBe(0);
		expect(generalWeekly?.amount.remainingFraction).toBe(1);
	});

	it("calls the international platform host with a Bearer api-key", async () => {
		const captures: CapturedRequest[] = [];
		await minimaxCodeUsageProvider.fetchUsage!(
			{ provider: "minimax-code", credential: makeCredential(), signal: undefined },
			makeCtx(
				{
					...okBaseResp(),
					model_remains: [
						modelRemain({
							model_name: "general",
							fiveHour: { total: 1, remaining: 1, endTime: 1783382400000 },
							weekly: { total: 1, remaining: 1, startTime: 1783296000000, endTime: 1783900800000 },
						}),
					],
				},
				captures,
			),
		);

		expect(captures).toHaveLength(1);
		expect(captures[0]!.url).toBe("https://www.minimax.io/v1/token_plan/remains");
		const headers = (captures[0]!.init.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-cp-test");
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("ignores providers that don't match its id", async () => {
		const report = await minimaxCodeUsageProvider.fetchUsage!(
			{ provider: "minimax-code-cn", credential: makeCredential(), signal: undefined },
			makeCtx({ ...okBaseResp(), model_remains: [] }),
		);
		expect(report).toBeNull();
	});

	it("returns null when base_resp.status_code is non-zero", async () => {
		const report = await minimaxCodeUsageProvider.fetchUsage!(
			{ provider: "minimax-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				base_resp: { status_code: 1004, status_msg: "cookie is missing, log in again" },
				model_remains: [],
			}),
		);
		expect(report).toBeNull();
	});

	it("returns null and warns when the HTTP response is non-OK", async () => {
		const warnings: unknown[][] = [];
		const ctx: UsageFetchContext = {
			fetch: makeErroringCtx(503).fetch,
			logger: {
				debug: () => {},
				warn: (...args: unknown[]) => {
					warnings.push(args);
				},
			},
		};
		const report = await minimaxCodeUsageProvider.fetchUsage!(
			{ provider: "minimax-code", credential: makeCredential(), signal: undefined },
			ctx,
		);
		expect(report).toBeNull();
		expect(warnings).toHaveLength(1);
	});

	it("warns and returns null when model_remains is empty", async () => {
		const warnings: unknown[][] = [];
		const ctx: UsageFetchContext = {
			fetch: makeCtx({ ...okBaseResp() }).fetch,
			logger: {
				debug: () => {},
				warn: (...args: unknown[]) => {
					warnings.push(args);
				},
			},
		};
		const report = await minimaxCodeUsageProvider.fetchUsage!(
			{ provider: "minimax-code", credential: makeCredential(), signal: undefined },
			ctx,
		);
		expect(report).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.[0]).toBe("MiniMax token plan usage response had no model rows");
	});

	it("rejects non api_key credentials", async () => {
		const report = await minimaxCodeUsageProvider.fetchUsage!(
			{
				provider: "minimax-code",
				credential: { type: "oauth", accessToken: "x" },
				signal: undefined,
			},
			makeCtx({}),
		);
		expect(report).toBeNull();
	});
});
