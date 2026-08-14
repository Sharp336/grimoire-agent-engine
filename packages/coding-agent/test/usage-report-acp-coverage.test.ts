import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

describe("buildUsageReportText model coverage", () => {
	it("collapses to a one-line summary when usage data covers every available model", async () => {
		const report: UsageReport = {
			provider: "test-provider",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "daily",
					label: "Daily",
					scope: { provider: "test-provider" },
					amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				},
			],
			metadata: { email: "acct@example.test" },
		};
		const text = await buildUsageReportText({
			session: {
				model: undefined,
				fetchUsageReports: async () => [report],
				getUsageReportingModelCoverage: () =>
					new Map([
						["test-provider", { reporting: ["test-provider/model-a", "test-provider/model-b"], availableCount: 2 }],
					]),
			},
		} as never);

		expect(text).toContain("Usage data covers all 2 available models");
		expect(text).not.toContain("Models with usage data");
		expect(text).not.toContain("test-provider/model-a");
	});
});
