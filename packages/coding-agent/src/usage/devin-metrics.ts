import type { UsageReport } from "@oh-my-pi/pi-ai";

export interface DevinUsageMetric {
	label: string;
	value: number;
}

/**
 * Extract normalized Devin activity metrics without adding provider-specific
 * fields to the generic usage report schema.
 */
export function getDevinUsageMetrics(report: UsageReport): DevinUsageMetric[] {
	if (report.provider !== "devin") return [];
	const rawMetrics = report.metadata?.metrics;
	if (!rawMetrics || typeof rawMetrics !== "object" || Array.isArray(rawMetrics)) return [];

	const metrics = rawMetrics as Record<string, unknown>;
	const definitions: Array<[key: string, singular: string, plural: string]> = [
		["sessionsCount", "session", "sessions"],
		["searchesCount", "search", "searches"],
		["prsCreatedCount", "PR created", "PRs created"],
		["prsMergedCount", "PR merged", "PRs merged"],
	];

	return definitions.flatMap(([key, singular, plural]) => {
		const value = metrics[key];
		if (typeof value !== "number" || !Number.isFinite(value)) return [];
		return [{ value, label: value === 1 ? singular : plural }];
	});
}
