import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { SlashCommandRuntime } from "../types";
import { formatDuration, renderAsciiBar } from "./format";
import { buildUsageInsightsText } from "./usage-insights";

function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function formatUsageReportAccount(report: UsageReport, limit: UsageLimit, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return email;
	const accountId = report.metadata?.accountId ?? limit.scope.accountId;
	if (typeof accountId === "string" && accountId) return accountId;
	const projectId = report.metadata?.projectId ?? limit.scope.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}

function formatUnlimitedReportAccount(report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return email;
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId) return accountId;
	const projectId = report.metadata?.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}

function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

function formatWindowSuffix(limit: UsageLimit): string {
	const window = limit.window?.label ?? limit.scope.windowId;
	if (!window || window.toLowerCase() === "quota window") return "";
	if (limit.label.toLowerCase().includes(window.toLowerCase())) return "";
	return ` — ${window}`;
}

function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	if (amount.limit !== undefined && amount.limit > 0 && amount.used !== undefined) return amount.used / amount.limit;
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	return undefined;
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/u, "");
}

function formatAmountValue(value: number, unit: UsageLimit["amount"]["unit"]): string {
	if (unit === "percent") return `${formatNumber(value)}%`;
	return `${formatNumber(value)} ${unit}`;
}

function formatUsageAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const fraction = resolveUsedFraction(limit);
	const parts: string[] = [];

	if (amount.used !== undefined) {
		if (amount.limit !== undefined && amount.limit > 0) {
			parts.push(
				`${formatAmountValue(amount.used, amount.unit)} / ${formatAmountValue(amount.limit, amount.unit)} used`,
			);
		} else {
			parts.push(`${formatAmountValue(amount.used, amount.unit)} used`);
		}
	} else if (fraction !== undefined) {
		parts.push(`${Math.round(fraction * 100)}% used`);
	} else {
		parts.push("unknown used");
	}

	if (amount.remaining !== undefined) {
		parts.push(`${formatAmountValue(amount.remaining, amount.unit)} left`);
	} else if (amount.remainingFraction !== undefined || fraction !== undefined) {
		const remainingFraction = amount.remainingFraction ?? Math.max(0, 1 - (fraction ?? 0));
		parts.push(`${Math.round(remainingFraction * 100)}% left`);
	}

	return parts.join(", ");
}

function resolveStatusLabel(limit: UsageLimit): string {
	if (limit.status === "exhausted") return "FULL";
	if (limit.status === "warning") return "WARN";
	if (limit.status === "ok") return "OK";
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) return "INFO";
	if (fraction >= 1) return "FULL";
	if (fraction >= 0.8) return "WARN";
	return "OK";
}

function renderUsageReports(reports: UsageReport[], nowMs: number): string {
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const lines = [`Usage${latestFetchedAt ? ` (${formatDuration(nowMs - latestFetchedAt)} ago)` : ""}`];
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const providerReports = grouped.get(report.provider) ?? [];
		providerReports.push(report);
		grouped.set(report.provider, providerReports);
	}

	for (const [provider, providerReports] of [...grouped.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		lines.push("", formatProviderName(provider));
		for (const report of providerReports) {
			if (report.limits.length === 0) {
				const account = formatUnlimitedReportAccount(report, 0);
				const tier = typeof report.metadata?.planType === "string" ? ` (${report.metadata.planType})` : "";
				lines.push(`- OK ${account}${tier}: no limits reported`);
				continue;
			}
			for (let index = 0; index < report.limits.length; index++) {
				const limit = report.limits[index]!;
				const reset = limit.window?.resetsAt ? `; resets in ${formatDuration(limit.window.resetsAt - nowMs)}` : "";
				lines.push(`- ${resolveStatusLabel(limit)} ${formatLimitTitle(limit)}${formatWindowSuffix(limit)}`);
				lines.push(`  ${formatUsageReportAccount(report, limit, index)}: ${formatUsageAmount(limit)}${reset}`);
				lines.push(`  ${renderAsciiBar(resolveUsedFraction(limit))}`);
				if (limit.notes && limit.notes.length > 0) lines.push(`  ${limit.notes.join(" • ")}`);
			}
		}
	}
	return ["```", ...lines, "```"].join("\n");
}

export function renderUsageReportsText(reports: UsageReport[], nowMs = Date.now()): string {
	if (reports.length === 0) return "Usage\nNo provider usage reports available.";
	return renderUsageReports(reports, nowMs);
}

/**
 * Build the `/usage` ACP-mode text. Prefers provider-reported limits when the
 * session exposes `fetchUsageReports`; otherwise falls back to the local
 * session-manager tallies.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime): Promise<string> {
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
	};
	if (provider.fetchUsageReports) {
		const reports = await provider.fetchUsageReports();
		if (reports && reports.length > 0) {
			const usageText = renderUsageReportsText(reports);
			const insightsText = await buildUsageInsightsText();
			return insightsText ? `${usageText}\n${insightsText}` : usageText;
		}
	}

	const stats = runtime.session.sessionManager.getUsageStatistics();
	const fallback = [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
	].join("\n");
	const insightsText = await buildUsageInsightsText();
	return insightsText ? `${fallback}\n${insightsText}` : fallback;
}
