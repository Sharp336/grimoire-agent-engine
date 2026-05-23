import { describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReportsText } from "./usage-report";

describe("renderUsageReportsText", () => {
	test("renders quota-style provider limits with remaining and reset details", () => {
		const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: nowMs - 60_000,
				metadata: { email: "pro@example.com" },
				limits: [
					{
						id: "gpt-5-5h",
						label: "GPT-5",
						scope: { provider: "openai-codex", tier: "Pro", windowId: "5h" },
						window: { id: "5h", label: "5 Hour", resetsAt: nowMs + 2 * 60 * 60 * 1000 },
						amount: { used: 25, limit: 100, unit: "requests" },
						status: "ok",
						notes: ["shared quota"],
					},
				],
			},
		];

		const rendered = renderUsageReportsText(reports, nowMs);

		expect(rendered).toContain("Usage (1m ago)");
		expect(rendered).toContain("Openai Codex");
		expect(rendered).toContain("- OK GPT-5 (Pro) — 5 Hour");
		expect(rendered).toContain("pro@example.com: 25 requests / 100 requests used, 75% left; resets in 2h");
		expect(rendered).toContain("shared quota");
	});

	test("derives status and used percent from remaining fraction", () => {
		const rendered = renderUsageReportsText(
			[
				{
					provider: "anthropic",
					fetchedAt: 0,
					limits: [
						{
							id: "window",
							label: "Claude",
							scope: { provider: "anthropic" },
							amount: { remainingFraction: 0.1, unit: "percent" },
						},
					],
				},
			],
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		expect(rendered).toContain("- WARN Claude");
		expect(rendered).toContain("90% used, 10% left");
	});

	test("renders unlimited accounts without quota limits", () => {
		const rendered = renderUsageReportsText(
			[
				{
					provider: "github-copilot",
					fetchedAt: 0,
					metadata: { accountId: "octocat", planType: "business" },
					limits: [],
				},
			],
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		expect(rendered).toContain("Github Copilot");
		expect(rendered).toContain("- OK octocat (business): no limits reported");
	});
});
