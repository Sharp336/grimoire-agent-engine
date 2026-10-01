import type { OAuthCredential, UsageReport } from "@oh-my-pi/pi-ai";
import { extractCursorAccessTokenUserId } from "@oh-my-pi/pi-ai/oauth/cursor";

export type UsageAccount = { provider_id: string; external_id: string | null; pools: Array<{ pool_id: string }>;
	quota_windows: Array<{ window_id: string; window_seconds: number }> };
export type UsageObservation = { metric: string; dimension: "pool" | "quota_window"; dimension_id: string;
	value: number | string; unit: string | null; observed_at: string; resets_at: string | null;
	window_start: string | null; window_end: string | null };

export const BUILTIN_PROVIDERS: Readonly<Record<string, string>> = {
	openai_codex_usage: "openai-codex",
	anthropic_claude_usage: "anthropic",
	cursor_usage: "cursor",
};
const codexLimitId = /^openai-codex:(?:primary|secondary|[a-z0-9-]+:(?:primary|secondary))$/;

/** Identity comes from the provider report, or Cursor's exact OAuth token claim. */
export function sameUsageAccount(provider: string, report: UsageReport, credential: OAuthCredential, accountId: string): boolean {
	if (report.provider !== provider || !Number.isFinite(report.fetchedAt)) return false;
	return provider === "cursor" ? extractCursorAccessTokenUserId(credential.access) === accountId
		: report.metadata?.accountId === accountId;
}

/** Pure normalization shared by periodic and before-phase readers; never fetches or invents a quota. */
export function usageObservations(report: UsageReport, account: UsageAccount): UsageObservation[] {
	if (report.provider !== account.provider_id || !Number.isFinite(report.fetchedAt)) return [];
	const provider = report.provider;
	const meterStates = report.metadata?.meterStates as Record<string, { allowed?: boolean; limitReached?: boolean }> | undefined;
	const observedAt = new Date(report.fetchedAt).toISOString();
	const observations: UsageObservation[] = [];
	for (const window of account.quota_windows) {
		const limit = report.limits.find(item => item.id === window.window_id &&
			(provider === "openai-codex" ? codexLimitId.test(item.id) : item.id.startsWith(`${provider}:`)) &&
			item.window?.durationMs === window.window_seconds * 1000);
		if (!limit) continue;
		let exhausted = limit.status === "exhausted";
		if (provider === "openai-codex") {
			const prefix = limit.id.slice("openai-codex:".length).replace(/:(?:primary|secondary)$/, "");
			const meter = prefix === "primary" || prefix === "secondary" ? "chat" : prefix;
			exhausted ||= meterStates?.[meter]?.allowed === false && meterStates[meter]?.limitReached === true;
		}
		const resets_at = limit.window?.resetsAt === undefined ? null : new Date(limit.window.resetsAt).toISOString();
		const base = { dimension: "quota_window" as const, dimension_id: window.window_id,
			observed_at: observedAt, resets_at, window_start: null, window_end: null };
		if (typeof limit.amount.remainingFraction === "number" && Number.isFinite(limit.amount.remainingFraction))
			observations.push({ ...base, metric: "quota_remaining", value: limit.amount.remainingFraction, unit: "fraction" });
		if (exhausted) observations.push({ ...base, metric: "exhausted", value: 1, unit: null });
	}
	// Provider units remain separate: percent-only rails do not become USD or request counts.
	for (const pool of account.pools) {
		const limit = report.limits.find(item => item.id === pool.pool_id && item.id.startsWith(`${provider}:`));
		if (!limit || !Number.isFinite(limit.amount.used)) continue;
		const resets_at = limit.window?.resetsAt === undefined ? null : new Date(limit.window.resetsAt).toISOString();
		const base = { dimension: "pool" as const, dimension_id: pool.pool_id,
			observed_at: observedAt, resets_at, window_start: null, window_end: null };
		if (limit.amount.unit === "usd")
			observations.push({ ...base, metric: "aggregate_spend_usd", value: limit.amount.used!, unit: "usd" });
		else if (limit.amount.unit === "requests")
			observations.push({ ...base, metric: "request_count", value: limit.amount.used!, unit: "requests" });
		else continue;
		if (limit.status === "exhausted") observations.push({ ...base, metric: "exhausted", value: 1, unit: null });
	}
	return observations;
}
