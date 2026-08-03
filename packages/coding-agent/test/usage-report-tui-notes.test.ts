/**
 * Regression coverage for the TUI aggregate path in `command-controller.ts`.
 *
 * Three contracts that the CLI `formatUsageBreakdown` test cannot cover,
 * because the bug lives in the TUI cross-account grouping renderer
 * `renderUsageReports`:
 *
 *  1. Provider-wide `UsageReport.notes` render ONCE above the per-account
 *     sections, not once per account/window.
 *  2. Identical per-limit notes from multiple accounts that fall in the same
 *     `label|windowId` group are de-duplicated.
 *  3. Wide terminals preserve organization suffixes that distinguish accounts
 *     sharing an email address.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	renderUsageModelRoster,
	renderUsageReports,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function limit(label: string, windowId: string, durationMs: number, frac: number, notes?: string[]) {
	return {
		id: windowId,
		label,
		scope: { provider: "github-copilot", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 0.8 ? "warning" : "ok",
		...(notes ? { notes } : {}),
	} satisfies UsageReport["limits"][number];
}

function report(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]) {
	return {
		provider,
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata: { email },
	} satisfies UsageReport;
}

describe("renderUsageReports (#3268 TUI aggregate)", () => {
	it("renders provider-wide UsageReport.notes exactly once for multiple accounts", () => {
		const disclaimer = "OMP-observed spend only; OpenCode usage outside OMP is not included.";
		const reports: UsageReport[] = [
			report(
				"opencode-go",
				"acct-a@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3)],
				[disclaimer],
			),
			report(
				"opencode-go",
				"acct-b@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.6)],
				[disclaimer],
			),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(disclaimer).length - 1;
		expect(occurrences).toBe(1);
	});

	it("summarizes the provider's usage-reporting models instead of listing them inline", () => {
		const reports = [
			report("github-copilot", "acct@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.4)]),
		];
		const models = ["github-copilot/gpt-5.6", "github-copilot/claude-sonnet-4.6"];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120, undefined, models));
		// The roster moved behind `/usage models`; the default view keeps the count
		// so the quota bars are not buried under it.
		expect(text).toContain("2 models");
		expect(text).not.toContain(models[0]);
		expect(text).not.toContain(models[1]);
	});

	it("groups the full model roster by provider for /usage models", () => {
		const models = ["github-copilot/gpt-5.6", "github-copilot/claude-sonnet-4.6", "anthropic/claude-opus-4-6"];
		const text = stripVTControlCharacters(renderUsageModelRoster(theme, models, 120));
		expect(text).toContain("Models with usage data");
		expect(text).toContain("github-copilot");
		expect(text).toContain("gpt-5.6");
		expect(text).toContain("claude-sonnet-4.6");
		expect(text).toContain("claude-opus-4-6");
	});

	it("deduplicates identical per-limit notes when accounts share one window group", () => {
		// Both accounts report the SAME label+windowId, so their limits land in
		// one aggregate group; both carry an identical per-limit note.
		const note = "Overage requests: 5";
		const reports: UsageReport[] = [
			report("github-copilot", "acct-a@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.8, [note])]),
			report("github-copilot", "acct-b@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.9, [note])]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(note).length - 1;
		// Deduped: appears once on the group note line. Pre-fix `flatMap(...).join`
		// would bullet-join it twice (one per account in the group).
		expect(occurrences).toBe(1);
	});

	it("preserves organization suffixes when wide account columns can fit them", () => {
		const now = Date.now();
		const accountLimit = () => ({
			...limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3),
			window: {
				id: "rolling-5h",
				label: "5 Hour limit",
				durationMs: 5 * HOUR,
				resetsAt: now + 2.5 * HOUR,
			},
		});
		const reports: UsageReport[] = [
			{
				...report("anthropic", "rae@example.com", [accountLimit()]),
				metadata: { email: "rae@example.com", orgId: "team-org", orgName: "Team Org" },
			},
			report("anthropic", "rae@example.com", [accountLimit()]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, now, 160));

		expect(text).toContain("rae@example.com (Team Org)");
	});

	it("shows a scoped account identity for a single report with empty metadata", () => {
		const baseLimit = limit("Daily", "daily", 24 * HOUR, 0.3);
		const scopedLimit = { ...baseLimit, scope: { ...baseLimit.scope, accountId: "scoped-account" } };
		const reports: UsageReport[] = [report("test-provider", "", [scopedLimit])];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));

		expect(text).toContain("scoped-account");
		expect(text).not.toContain("account 1");
	});

	it("renders used-only absolute amounts with neutral status and no account summary", () => {
		const reports: UsageReport[] = [
			report("anthropic", "spend@example.test", [
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { used: 123.45, unit: "usd" },
				},
			]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));

		expect(text).toContain(theme.status.info);
		expect(text).not.toContain(theme.status.pending);
		expect(text).toContain("$123.45 used");
		expect(text).not.toContain("1 accts");
	});

	it("keeps a per-account cell for every account when a group mixes capped and used-only amounts", () => {
		const reports: UsageReport[] = [
			report("anthropic", "capped@example.test", [
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: {
						used: 50,
						limit: 100,
						remaining: 50,
						usedFraction: 0.5,
						remainingFraction: 0.5,
						unit: "usd",
					},
					status: "ok",
				},
			]),
			report("anthropic", "spend@example.test", [
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { used: 123.45, unit: "usd" },
				},
			]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));

		expect(text).toContain(theme.status.success);
		// The capped account resolves to a percentage; the used-only sibling keeps
		// its absolute amount. Both occupy their own column on the same row.
		expect(text).toContain("50%");
		expect(text).toContain("$123.45 used");
		const row = text.split("\n").find(line => line.includes("$123.45 used"));
		expect(row).toContain("50%");
	});
});

describe("renderUsageReports session marker (#5691 org-qualified identity)", () => {
	it("names the org-qualified session identity when no reported account matches it", () => {
		const email = "dev@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		// The identity carries an org; the report metadata does not, so the org
		// gate rejects the match and the session must still be attributed.
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email, orgId: "uuid-A", orgName: "Team Org" } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(`${email} (Team Org)`);
	});

	it("marks the matching account column instead of repeating the session identity", () => {
		const email = "solo@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email } : undefined,
			),
		);
		const heading = text.split("\n").find(line => line.includes("anthropic"));
		expect(heading).toContain(theme.status.enabled);
		expect(heading).toContain(email);
		expect(heading).not.toContain("(");
		expect(text).not.toContain("in use by this session");
	});
});
