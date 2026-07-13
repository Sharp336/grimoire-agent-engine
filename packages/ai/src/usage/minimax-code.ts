/**
 * MiniMax "Token Plan" Coding Plan usage provider.
 *
 * MiniMax exposes quota on the platform host (`www.minimax.io`) at
 * `GET /v1/token_plan/remains`. The endpoint is authenticated with the
 * same `sk-cp-…` api-key the user pasted at `/login minimax-code`.
 *
 * Response shape (2026-Q3):
 *   {
 *     "model_remains": [
 *       {
 *         "end_time":                        1783382400000,  // 5h window end (ms)
 *         "current_interval_total_count":    N,
 *         "current_interval_usage_count":    M,              // remaining (note: misleading name)
 *         "model_name":                      "general" | "video" | ...,
 *         "current_interval_status":         1 | 3,          // 1 = active, 3 = unlimited
 *         "current_interval_remaining_percent": 83,
 *         "current_weekly_total_count":      N,
 *         "current_weekly_usage_count":      M,              // remaining
 *         "weekly_end_time":                 1783900800000,
 *         "current_weekly_status":           1 | 3,
 *         "current_weekly_remaining_percent": 100
 *       },
 *       ...
 *     ],
 *     "base_resp": { "status_code": 0, "status_msg": "success" }
 *   }
 *
 * Field semantics
 * - The fields named `*_usage_count` are actually **remaining** quota, not
 *   consumed. The corresponding `*_remaining_percent` is computed against
 *   that denominator and matches.
 * - `*_status === 3` is the Coding Plan's "unlimited" state per the web
 *   UI, not "exhausted". `*_status === 1` is the active, capped state —
 *   the percent + totals are trustworthy.
 *
 * Only the `general` row is surfaced; other products (e.g. `video`) are
 * dropped since the renderer only handles a single product. Rows with a
 * missing `model_name` default to `general` and are kept.
 */
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { toNumber } from "./shared";

const MINIMAX_CODE_PROVIDER = "minimax-code";
const INTL_TOKEN_PLAN_HOST = "https://www.minimax.io";
const USAGE_PATH = "/v1/token_plan/remains";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** `*_status: 3` is the Coding Plan's "unlimited" state; `1` is active/capped. */
const STATUS_UNLIMITED = 3;

interface MiniMaxModelRemain {
	model_name?: unknown;
	start_time?: unknown;
	end_time?: unknown;
	remains_time?: unknown;
	current_interval_total_count?: unknown;
	current_interval_usage_count?: unknown;
	current_interval_status?: unknown;
	current_interval_remaining_percent?: unknown;
	current_weekly_total_count?: unknown;
	current_weekly_usage_count?: unknown;
	weekly_start_time?: unknown;
	weekly_end_time?: unknown;
	weekly_remains_time?: unknown;
	current_weekly_status?: unknown;
	current_weekly_remaining_percent?: unknown;
}

interface MiniMaxTokenPlanPayload {
	base_resp?: { status_code?: number; status_msg?: string };
	model_remains?: unknown;
}

interface WindowState {
	resetsAt?: number;
	remainingPercent?: number;
	totalCount?: number;
	remainingCount?: number;
	status?: number;
}

interface WindowSpec {
	id: string;
	label: string;
	durationMs: number;
	totalKey: keyof MiniMaxModelRemain;
	remainingKey: keyof MiniMaxModelRemain;
	percentKey: keyof MiniMaxModelRemain;
	statusKey: keyof MiniMaxModelRemain;
	endKey: keyof MiniMaxModelRemain;
}

const WINDOW_INTERVAL: WindowSpec = {
	id: "5h",
	label: "5 Hour",
	durationMs: 5 * HOUR_MS,
	totalKey: "current_interval_total_count",
	remainingKey: "current_interval_usage_count",
	percentKey: "current_interval_remaining_percent",
	statusKey: "current_interval_status",
	endKey: "end_time",
};

const WINDOW_WEEKLY: WindowSpec = {
	id: "weekly",
	label: "Weekly",
	durationMs: 7 * DAY_MS,
	totalKey: "current_weekly_total_count",
	remainingKey: "current_weekly_usage_count",
	percentKey: "current_weekly_remaining_percent",
	statusKey: "current_weekly_status",
	endKey: "weekly_end_time",
};

function readWindowState(row: MiniMaxModelRemain, spec: WindowSpec): WindowState {
	return {
		resetsAt: toNumber(row[spec.endKey]),
		remainingPercent: toNumber(row[spec.percentKey]),
		totalCount: toNumber(row[spec.totalKey]),
		remainingCount: toNumber(row[spec.remainingKey]),
		status: toNumber(row[spec.statusKey]),
	};
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

function buildAmount(state: WindowState): UsageAmount {
	const pctRaw = state.remainingPercent;
	const total = state.totalCount !== undefined ? Math.max(0, state.totalCount) : undefined;
	const remaining = state.remainingCount !== undefined ? Math.max(0, state.remainingCount) : undefined;

	const amount: UsageAmount = { unit: "requests" };

	// Prefer numeric totals when present: they give exact used/remaining
	// counts. Otherwise derive from `*_remaining_percent`.
	if (total !== undefined && total > 0 && remaining !== undefined) {
		const safeRemaining = Math.min(remaining, total);
		const used = Math.max(0, total - safeRemaining);
		amount.limit = total;
		amount.remaining = safeRemaining;
		amount.used = used;
		amount.usedFraction = used / total;
		amount.remainingFraction = safeRemaining / total;
	} else if (pctRaw !== undefined) {
		const pct = clampPercent(pctRaw);
		amount.remainingFraction = pct / 100;
		amount.usedFraction = (100 - pct) / 100;
	} else {
		amount.remainingFraction = 1;
		amount.usedFraction = 0;
	}

	return amount;
}

function resolveLimitStatus(state: WindowState, usedFraction: number): UsageStatus {
	// `*_status: 3` is "unlimited" on the Coding Plan, not "exhausted".
	if (state.status === STATUS_UNLIMITED) return "ok";
	if (!Number.isFinite(usedFraction)) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.8) return "warning";
	return "ok";
}

function buildUsageWindow(spec: WindowSpec, resetsAt: number | undefined): UsageWindow {
	const out: UsageWindow = { id: spec.id, label: spec.label, durationMs: spec.durationMs };
	if (resetsAt !== undefined) out.resetsAt = resetsAt;
	return out;
}

function buildLimit(args: { providerId: string; tier: string; window: UsageWindow; state: WindowState }): UsageLimit {
	const { providerId, tier, window, state } = args;
	const amount = buildAmount(state);
	const status = resolveLimitStatus(state, amount.usedFraction ?? 0);
	const tierSlug = tier.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
	const limit: UsageLimit = {
		id: `${providerId}:${window.id}:${tierSlug}`,
		label: `MiniMax ${tier} ${window.label} quota`,
		scope: {
			provider: providerId,
			windowId: window.id,
			tier,
			shared: true,
		},
		window,
		amount,
		status,
	};
	if (state.status === STATUS_UNLIMITED) {
		limit.notes = ["Unlimited on this window — see Coding Plan."];
	}
	return limit;
}

function pickModelRows(payload: unknown): MiniMaxModelRemain[] {
	if (!isRecord(payload)) return [];
	const data = payload as MiniMaxTokenPlanPayload;
	return Array.isArray(data.model_remains)
		? data.model_remains.filter((row): row is MiniMaxModelRemain => isRecord(row))
		: [];
}

function rowHasWindowSignal(row: MiniMaxModelRemain, spec: WindowSpec): boolean {
	return (
		toNumber(row[spec.percentKey]) !== undefined ||
		toNumber(row[spec.totalKey]) !== undefined ||
		toNumber(row[spec.statusKey]) !== undefined
	);
}

async function fetchMiniMaxCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== MINIMAX_CODE_PROVIDER) return null;
	if (params.credential.type !== "api_key" || !params.credential.apiKey) return null;

	const url = `${INTL_TOKEN_PLAN_HOST.replace(/\/+$/, "")}${USAGE_PATH}`;
	let payload: unknown;
	try {
		const response = await ctx.fetch(url, {
			headers: {
				Authorization: `Bearer ${params.credential.apiKey}`,
				"Content-Type": "application/json",
			},
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("MiniMax token plan usage request failed", {
				provider: params.provider,
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		ctx.logger?.warn("MiniMax token plan usage request error", {
			provider: params.provider,
			error: String(error),
		});
		return null;
	}

	if (!isRecord(payload)) {
		ctx.logger?.warn("MiniMax token plan usage response invalid", { provider: params.provider });
		return null;
	}

	const data = payload as MiniMaxTokenPlanPayload;
	const baseResp = isRecord(data.base_resp) ? data.base_resp : undefined;
	const baseStatus = baseResp ? toNumber(baseResp.status_code) : 0;
	if (baseStatus !== 0) {
		ctx.logger?.warn("MiniMax token plan usage returned non-success status", {
			provider: params.provider,
			statusCode: baseStatus,
			statusMsg: typeof baseResp?.status_msg === "string" ? baseResp.status_msg : undefined,
		});
		return null;
	}

	const rows = pickModelRows(payload);
	if (rows.length === 0) {
		ctx.logger?.warn("MiniMax token plan usage response had no model rows", {
			provider: params.provider,
			rawKeys: Object.keys(data),
		});
		return null;
	}

	const limits: UsageLimit[] = [];
	const tiersSeen: string[] = [];
	for (const row of rows) {
		// Drop non-general products (e.g. "video") — the renderer only
		// handles a single product. Rows whose model_name is missing
		// default to "general" and are kept.
		const rawName = typeof row.model_name === "string" ? row.model_name : "";
		if (rawName && rawName !== "general") continue;
		const tier = rawName || "general";
		tiersSeen.push(tier);
		const intervalState = readWindowState(row, WINDOW_INTERVAL);
		const weeklyState = readWindowState(row, WINDOW_WEEKLY);
		if (rowHasWindowSignal(row, WINDOW_INTERVAL)) {
			limits.push(
				buildLimit({
					providerId: params.provider,
					tier,
					window: buildUsageWindow(WINDOW_INTERVAL, intervalState.resetsAt),
					state: intervalState,
				}),
			);
		}
		if (rowHasWindowSignal(row, WINDOW_WEEKLY)) {
			limits.push(
				buildLimit({
					providerId: params.provider,
					tier,
					window: buildUsageWindow(WINDOW_WEEKLY, weeklyState.resetsAt),
					state: weeklyState,
				}),
			);
		}
	}

	if (limits.length === 0) {
		ctx.logger?.warn("MiniMax token plan usage response carried no usable quota", {
			provider: params.provider,
			rowCount: rows.length,
			sample: rows[0] ?? null,
		});
		return null;
	}

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: url,
			tiers: tiersSeen,
		},
		raw: data,
	};
}

export const minimaxCodeUsageProvider: UsageProvider = {
	id: MINIMAX_CODE_PROVIDER,
	supports: params => params.provider === MINIMAX_CODE_PROVIDER && params.credential.type === "api_key",
	fetchUsage: fetchMiniMaxCodeUsage,
};
