import { describe, expect, it } from "bun:test";
import {
	buildQuotaDashboardModel,
	cleanOrgName,
	formatProviderName,
	type LocalActiveIdentity,
	type LocalUsageLimit,
	type LocalUsageReport,
} from "../src/hierarchy";

const NOW = 1_700_000_000_000;

function limit(overrides: Partial<LocalUsageLimit> = {}): LocalUsageLimit {
	return {
		id: "test:limit",
		label: "7 Day",
		scope: { provider: "test" },
		amount: { unit: "percent", remainingFraction: 1.0 },
		...overrides,
	};
}

function report(overrides: Partial<LocalUsageReport> = {}): LocalUsageReport {
	return {
		provider: "test-provider",
		fetchedAt: NOW,
		limits: [limit()],
		metadata: { email: "user@example.com" },
		...overrides,
	};
}

describe("hierarchy data model and grouping", () => {
	describe("cleanOrgName", () => {
		it("12. cleans redundant organization names without corrupting real ones", () => {
			expect(cleanOrgName("kareem.jalal@jethur.com's Organization", "kareem.jalal@jethur.com")).toBe("Organization");
			expect(cleanOrgName("kareem's Workspace", "kareem@jethur.com")).toBe("Workspace");
			expect(cleanOrgName("user@example.com", "user@example.com")).toBeUndefined();
			expect(cleanOrgName("Jethur Corp", "kareem.jalal@jethur.com")).toBe("Jethur Corp");
			expect(cleanOrgName("Team Workspace", "osama@example.com")).toBe("Team Workspace");
		});
	});

	describe("formatProviderName", () => {
		it("formats provider identifiers with proper casing including OpenAI acronym", () => {
			expect(formatProviderName("anthropic")).toBe("Anthropic");
			expect(formatProviderName("google-antigravity")).toBe("Google Antigravity");
			expect(formatProviderName("openai-codex")).toBe("OpenAI Codex");
		});
	});

	describe("buildQuotaDashboardModel", () => {
		it("8. groups multiple accounts under each provider cleanly", () => {
			const reports = [
				report({
					provider: "google-antigravity",
					metadata: { email: "osama15@gmail.com" },
					limits: [
						limit({
							id: "google-antigravity:google:default:weekly",
							label: "Usage (Google)",
							amount: { unit: "percent", remainingFraction: 0 },
						}),
					],
				}),
				report({
					provider: "google-antigravity",
					metadata: { email: "adel@gmail.com" },
					limits: [
						limit({
							id: "google-antigravity:google:default:daily",
							label: "Usage (Google)",
							amount: { unit: "percent", remainingFraction: 1 },
						}),
					],
				}),
			];

			const model = buildQuotaDashboardModel(reports, NOW, new Map());
			expect(model.providers).toHaveLength(1);
			expect(model.providers[0]!.accounts).toHaveLength(2);
			expect(model.providers[0]!.accounts[0]!.label).toBe("osama15@gmail.com");
			expect(model.providers[0]!.accounts[1]!.label).toBe("adel@gmail.com");
		});

		it("9. preserves Antigravity independent Google / Anthropic / OpenAI pools", () => {
			const reports = [
				report({
					provider: "google-antigravity",
					metadata: { email: "osama@gmail.com" },
					limits: [
						limit({
							id: "google-antigravity:google:default:weekly",
							label: "Usage (Google)",
							window: { id: "weekly", label: "Weekly" },
							amount: { unit: "percent", remainingFraction: 0 },
						}),
						limit({
							id: "google-antigravity:google:default:daily",
							label: "Usage (Google)",
							window: { id: "daily", label: "Daily" },
							amount: { unit: "percent", remainingFraction: 1 },
						}),
						limit({
							id: "google-antigravity:anthropic:default:weekly",
							label: "Usage (Anthropic)",
							window: { id: "weekly", label: "Weekly" },
							amount: { unit: "percent", remainingFraction: 1 },
						}),
						limit({
							id: "google-antigravity:openai:default:weekly",
							label: "Usage (OpenAI)",
							window: { id: "weekly", label: "Weekly" },
							amount: { unit: "percent", remainingFraction: 1 },
						}),
					],
				}),
			];

			const model = buildQuotaDashboardModel(reports, NOW, new Map());
			const account = model.providers[0]!.accounts[0]!;
			expect(account.pools).toHaveLength(3);
			expect(account.pools.map(p => p.label)).toEqual(["Google", "Anthropic", "OpenAI"]);
			expect(account.pools[0]!.rows).toHaveLength(2); // Weekly + Daily
			expect(account.pools[1]!.rows).toHaveLength(1); // Weekly
			expect(account.pools[2]!.rows).toHaveLength(1); // Weekly
		});

		it("10. marks the active account correctly and exclusively", () => {
			const reports = [
				report({ provider: "anthropic", metadata: { email: "active@jethur.com" } }),
				report({ provider: "anthropic", metadata: { email: "inactive@jethur.com" } }),
			];

			const activeMap = new Map<string, LocalActiveIdentity>([["anthropic", { email: "active@jethur.com" }]]);

			const model = buildQuotaDashboardModel(reports, NOW, activeMap);
			const accounts = model.providers[0]!.accounts;
			expect(accounts[0]!.isActive).toBe(true);
			expect(accounts[1]!.isActive).toBe(false);
		});

		it("6 & 7. calculates summary counts and derives attention items correctly", () => {
			const reports = [
				report({
					provider: "anthropic",
					metadata: { email: "kareem@jethur.com" },
					limits: [
						limit({ id: "5h", label: "5 Hour", amount: { unit: "percent", remainingFraction: 0.93 } }), // healthy
						limit({ id: "7d", label: "7 Day", amount: { unit: "percent", remainingFraction: 0.29 } }), // low
					],
				}),
				report({
					provider: "google-antigravity",
					metadata: { email: "osama@gmail.com" },
					limits: [
						limit({
							id: "google-antigravity:google:default:weekly",
							label: "Usage (Google)",
							amount: { unit: "percent", remainingFraction: 0 },
						}), // exhausted
						limit({
							id: "google-antigravity:google:default:daily",
							label: "Usage (Google)",
							amount: { unit: "percent", remainingFraction: 0.12 },
						}), // critical
					],
				}),
			];

			const model = buildQuotaDashboardModel(reports, NOW, new Map());
			expect(model.summary.totalCount).toBe(4);
			expect(model.summary.healthyCount).toBe(1);
			expect(model.summary.lowCount).toBe(1);
			expect(model.summary.criticalCount).toBe(1);
			expect(model.summary.exhaustedCount).toBe(1);
			expect(model.summary.allHealthy).toBe(false);

			// Attention items should contain low, critical, exhausted items (not healthy)
			expect(model.attentionItems).toHaveLength(3);
			expect(model.attentionItems.map(item => item.health.status)).toEqual(["low", "exhausted", "critical"]);
		});

		it("11. computes account health summaries for collapsed states", () => {
			const r = report({
				provider: "openai-codex",
				metadata: { email: "osama@gmail.com" },
				limits: [limit({ id: "7d", label: "7 Day", amount: { unit: "percent", remainingFraction: 0 } })],
			});

			const model = buildQuotaDashboardModel([r], NOW, new Map());
			const account = model.providers[0]!.accounts[0]!;
			expect(account.healthSummary.hasIssues).toBe(true);
			expect(account.healthSummary.exhaustedCount).toBe(1);
			expect(account.healthSummary.summaryText).toBe("1 exhausted");
		});

		it("15. handles accounts with no reported limits cleanly", () => {
			const r = report({
				provider: "anthropic",
				metadata: { email: "unlimited@example.com" },
				limits: [],
			});

			const model = buildQuotaDashboardModel([r], NOW, new Map());
			const account = model.providers[0]!.accounts[0]!;
			expect(account.noLimits).toBe(true);
			expect(account.pools).toHaveLength(0);
			expect(account.healthSummary.summaryText).toBe("no limits");
		});

		it("16. handles absolute-usage only (neutral) limits", () => {
			const r = report({
				provider: "anthropic",
				metadata: { email: "spend@example.com" },
				limits: [limit({ id: "extra", label: "Claude Extra Usage", amount: { used: 123.45, unit: "usd" } })],
			});

			const model = buildQuotaDashboardModel([r], NOW, new Map());
			const account = model.providers[0]!.accounts[0]!;
			expect(account.pools[0]!.rows[0]!.health.status).toBe("neutral");
			expect(account.pools[0]!.rows[0]!.usedText).toBe("$123.45 used");
		});
	});
});
