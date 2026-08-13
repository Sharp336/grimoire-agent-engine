import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function win(label: string, windowId: string, durationMs: number, frac: number) {
	return {
		id: windowId,
		label,
		scope: { provider: "kimi-code", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 1 ? "exhausted" : frac >= 0.9 ? "warning" : "ok",
	} satisfies UsageReport["limits"][number];
}

function acct(email: string, total: number, fiveH: number): UsageReport {
	return {
		provider: "kimi-code",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			win("Total quota", "usage-window", 7 * 24 * HOUR, total),
			win("5h limit", "rolling-5h", 5 * HOUR, fiveH),
		],
	} satisfies UsageReport;
}

function spendAcct(email: string, used: number, limit?: number): UsageReport {
	const amount =
		limit === undefined
			? ({ used, unit: "usd" } as const)
			: ({
					used,
					unit: "usd",
					limit,
					remaining: Math.max(0, limit - used),
					usedFraction: used / limit,
					remainingFraction: Math.max(0, limit - used) / limit,
				} as const);
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			{
				id: "anthropic:extra",
				label: "Claude Extra Usage",
				scope: { provider: "anthropic", windowId: "extra" },
				amount,
				...(limit === undefined ? {} : { status: "ok" as const }),
			},
		],
	};
}

describe("renderUsageReports multi-account column alignment (#6067)", () => {
	it("keeps every window row on the single account-legend column order", () => {
		// Account A: weekly exhausted, 5h free. Account B: weekly light, 5h exhausted.
		// A naive per-window sort by used fraction swaps the columns between rows,
		// so the exhausted cell lands under the sibling that still has quota.
		const reports: UsageReport[] = [acct("alice@example.test", 1.0, 0.0), acct("bob@example.test", 0.2, 1.0)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));
		const lines = text.split("\n");

		const legend = lines.find(line => line.includes("alice") && line.includes("bob"));
		expect(legend).toBeDefined();
		expect(legend!.indexOf("alice")).toBeLessThan(legend!.indexOf("bob"));

		const percents = (rowLabel: string): string[] => {
			const row = lines.find(line => line.includes(rowLabel));
			expect(row).toBeDefined();
			return [...row!.matchAll(/(\d+)%/g)].map(match => match[0]);
		};

		// Column 0 is alice, column 1 is bob, on BOTH rows.
		expect(percents("Total quota")).toEqual(["0%", "80%"]);
		expect(percents("5h limit")).toEqual(["100%", "0%"]);
	});

	it("keeps every line inside the terminal when used-only amounts squeeze the columns", () => {
		const reports = [spendAcct("first@example.test", 123.45), spendAcct("second@example.test", 67.89)];
		for (const width of [11, 20, 40, 80]) {
			const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), width));
			for (const line of text.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("drops the bar before the percentage when a mixed group runs out of width", () => {
		const reports = [spendAcct("capped@example.test", 50, 100), spendAcct("uncapped@example.test", 123.45)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 30));
		const row = text.split("\n").find(line => line.includes("50%"));

		// Narrow terminals keep the number readers need and give up the bar glyphs
		// first (issue #5770: percentage outranks decoration).
		expect(row).toBeDefined();
		expect(row).not.toContain("█");
		expect(Bun.stringWidth(row!)).toBeLessThanOrEqual(30);
	});
});

describe("renderUsageReports shared reset column", () => {
	function resetAcct(email: string, resetsInMs: number): UsageReport {
		const now = Date.now();
		return {
			provider: "openai-codex",
			fetchedAt: now,
			metadata: { email },
			limits: [
				{
					id: "7d",
					label: "7 days",
					scope: { provider: "openai-codex", windowId: "7d" },
					window: { id: "7d", label: "7 days", durationMs: 7 * 24 * HOUR, resetsAt: now + resetsInMs },
					amount: { unit: "percent", usedFraction: 0.4 },
					status: "ok",
				},
			],
		};
	}

	it("keeps a countdown when accounts on one window reset at different times", () => {
		// The old layout carried a per-account `(6d)` suffix on every label, so a
		// single hoisted countdown must not silently blank when they disagree —
		// independent 7-day windows almost never line up.
		const reports = [resetAcct("early@example.test", 6 * HOUR), resetAcct("late@example.test", 5 * 24 * HOUR)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));
		const row = text.split("\n").find(line => line.includes("7 days"));

		expect(row).toBeDefined();
		expect(row).toContain("resets in");
		// Both bounds stay visible so neither account's return is hidden.
		expect(row).toContain("6h");
		expect(row).toContain("5d");
	});

	it("collapses to one countdown when every account agrees", () => {
		const reports = [resetAcct("a@example.test", 3 * HOUR), resetAcct("b@example.test", 3 * HOUR)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));
		const row = text.split("\n").find(line => line.includes("7 days"))!;

		expect([...row.matchAll(/resets in/g)]).toHaveLength(1);
		expect(row).not.toContain("–");
	});
});
