import { describe, expect, test } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../usage";
import { minimaxCodeCnUsageProvider, minimaxCodeUsageProvider } from "./minimax-code";

function makeParams(provider: string): UsageFetchParams {
	return {
		provider,
		credential: { type: "api_key", apiKey: "test-key" },
	};
}

function makeContext(payload: unknown): UsageFetchContext {
	const fetchJson = (async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
	return { fetch: fetchJson };
}

describe("MiniMax Coding Plan usage provider", () => {
	test("normalizes international remaining counts", async () => {
		const report = await minimaxCodeUsageProvider.fetchUsage(
			makeParams("minimax-code"),
			makeContext({
				base_resp: { status_code: 0, status_msg: "" },
				model_remains: [
					{
						model_name: "MiniMax-M*",
						current_interval_total_count: 100,
						current_interval_usage_count: 75,
						remains_time: 3_600_000,
						current_weekly_total_count: 500,
						current_weekly_usage_count: 400,
						weekly_remains_time: 86_400_000,
					},
				],
			}),
		);

		expect(report?.provider).toBe("minimax-code");
		expect(report?.limits).toHaveLength(2);
		expect(report?.limits[0]?.amount.used).toBe(25);
		expect(report?.limits[0]?.amount.remaining).toBe(75);
		expect(report?.limits[0]?.amount.usedFraction).toBe(0.25);
		expect(report?.limits[1]?.amount.used).toBe(100);
		expect(report?.limits[1]?.amount.remaining).toBe(400);
	});

	test("normalizes China used counts", async () => {
		const report = await minimaxCodeCnUsageProvider.fetchUsage(
			makeParams("minimax-code-cn"),
			makeContext({
				base_resp: { status_code: 0, status_msg: "" },
				model_remains: [
					{
						model_name: "MiniMax-M2",
						current_interval_total_count: 100,
						current_interval_usage_count: 60,
						remains_time: 3_600_000,
					},
				],
			}),
		);

		expect(report?.provider).toBe("minimax-code-cn");
		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]?.amount.used).toBe(60);
		expect(report?.limits[0]?.amount.remaining).toBe(40);
		expect(report?.limits[0]?.status).toBe("ok");
	});

	test("returns null for application errors", async () => {
		const report = await minimaxCodeUsageProvider.fetchUsage(
			makeParams("minimax-code"),
			makeContext({ base_resp: { status_code: 1001, status_msg: "bad token" }, model_remains: [] }),
		);

		expect(report).toBeNull();
	});
});
