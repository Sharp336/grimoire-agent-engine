import { describe, expect, it } from "bun:test";
import { kiroUsageProvider, parseKiroUsage } from "@oh-my-pi/pi-ai/usage/kiro";

function payload(entries: unknown[], nextDateReset: number = 1_800_000_000): unknown {
	return { usageBreakdownList: entries, nextDateReset };
}

describe("Kiro usage", () => {
	it("prefers precision fields and normalizes reset seconds", () => {
		const report = parseKiroUsage(
			payload([
				{
					resourceType: "CHAT",
					displayNamePlural: "Credits",
					currentUsage: 1,
					currentUsageWithPrecision: 1.25,
					usageLimit: 10,
					usageLimitWithPrecision: 2.5,
				},
			]),
			undefined,
			123,
		);
		expect(report?.fetchedAt).toBe(123);
		expect(report?.limits[0]).toMatchObject({
			status: "ok",
			window: { resetsAt: 1_800_000_000_000 },
			amount: { used: 1.25, limit: 2.5, remaining: 1.25, usedFraction: 0.5 },
		});
	});

	it("classifies zero and consumed limits as exhausted and accepts millisecond resets", () => {
		const report = parseKiroUsage(
			payload(
				[
					{ resourceType: "ZERO", currentUsage: 0, usageLimit: 0 },
					{ resourceType: "FULL", currentUsage: 10, usageLimit: 10 },
				],
				1_800_000_000_000,
			),
		);
		expect(report?.limits.map(limit => [limit.id, limit.status])).toEqual([
			["kiro:zero", "exhausted"],
			["kiro:full", "exhausted"],
		]);
		expect(report?.limits[0]?.window?.resetsAt).toBe(1_800_000_000_000);
	});

	it("builds a profile-scoped regional request", async () => {
		let url = "";
		let body = "";
		const profileArn = "arn:aws:codewhisperer:ap-southeast-2:123:profile/test";
		const report = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: { type: "oauth", accessToken: "token", profileArn } },
			{
				fetch: async (input, init) => {
					url = String(input);
					body = String(init?.body);
					return Response.json(payload([{ resourceType: "CHAT", currentUsage: 1, usageLimit: 2 }]));
				},
			},
		);
		expect(url).toBe(
			"https://management.ap-southeast-2.kiro.dev/?origin=KIRO_CLI&profileArn=arn%3Aaws%3Acodewhisperer%3Aap-southeast-2%3A123%3Aprofile%2Ftest",
		);
		expect(JSON.parse(body)).toEqual({ origin: "KIRO_CLI", profileArn });
		expect(report?.metadata).toEqual({ profileArn });
	});

	it("returns null for malformed and non-success responses", async () => {
		expect(parseKiroUsage({ usageBreakdownList: "bad" })).toBeNull();
		const report = await kiroUsageProvider.fetchUsage(
			{ provider: "kiro", credential: { type: "api_key", apiKey: "token" } },
			{ fetch: async () => new Response("no", { status: 503 }) },
		);
		expect(report).toBeNull();
	});
});
