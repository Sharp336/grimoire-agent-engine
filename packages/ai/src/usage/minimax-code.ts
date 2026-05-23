import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";

const MINIMAX_INTL_QUOTA_URL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const MINIMAX_CN_QUOTA_URL = "https://api.minimaxi.com/v1/token_plan/remains";
const USER_AGENT = "Oh-My-Pi/1.0";

type MiniMaxProvider = "minimax-code" | "minimax-code-cn";
type MiniMaxCountSemantics = "remaining" | "used";

interface MiniMaxModelRemain {
	model_name: string;
	current_interval_total_count: number;
	current_interval_usage_count: number;
	remains_time: number;
	current_weekly_total_count?: number;
	current_weekly_usage_count?: number;
	weekly_remains_time?: number;
}

interface MiniMaxApiResponse {
	model_remains?: unknown[];
	base_resp?: {
		status_code?: number;
		status_msg?: string;
	};
}

interface MiniMaxWindowSpec {
	id: string;
	label: string;
	getTotal(model: MiniMaxModelRemain): number | undefined;
	getCount(model: MiniMaxModelRemain): number | undefined;
	getResetOffsetMs(model: MiniMaxModelRemain): number | undefined;
}

const WINDOW_SPECS: readonly MiniMaxWindowSpec[] = [
	{
		id: "5h",
		label: "5 Hour",
		getTotal: model => model.current_interval_total_count,
		getCount: model => model.current_interval_usage_count,
		getResetOffsetMs: model => model.remains_time,
	},
	{
		id: "weekly",
		label: "Weekly",
		getTotal: model => model.current_weekly_total_count,
		getCount: model => model.current_weekly_usage_count,
		getResetOffsetMs: model => model.weekly_remains_time,
	},
];

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isMiniMaxModelRecord(value: unknown): value is MiniMaxModelRemain {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.model_name === "string" &&
		isFiniteNumber(record.current_interval_total_count) &&
		isFiniteNumber(record.current_interval_usage_count) &&
		isFiniteNumber(record.remains_time)
	);
}

function isMiniMaxCodingModel(modelName: string): boolean {
	const normalized = modelName.trim().toLowerCase();
	return normalized === "minimax-m*" || normalized.startsWith("minimax-m");
}

function normalizeCounts(
	total: number,
	rawCount: number,
	semantics: MiniMaxCountSemantics,
): { used: number; remaining: number } {
	if (semantics === "used") {
		const used = Math.min(total, Math.max(0, rawCount));
		return { used, remaining: Math.max(0, total - used) };
	}
	const remaining = Math.min(total, Math.max(0, rawCount));
	return { used: Math.max(0, total - remaining), remaining };
}

function buildLimit(
	provider: MiniMaxProvider,
	model: MiniMaxModelRemain,
	spec: MiniMaxWindowSpec,
	semantics: MiniMaxCountSemantics,
	nowMs: number,
): UsageLimit | undefined {
	const total = spec.getTotal(model);
	const rawCount = spec.getCount(model);
	const resetOffsetMs = spec.getResetOffsetMs(model);
	if (!isFiniteNumber(total) || !isFiniteNumber(rawCount) || !isFiniteNumber(resetOffsetMs) || total <= 0) {
		return undefined;
	}

	const { used, remaining } = normalizeCounts(total, rawCount, semantics);
	const usedFraction = used / total;
	const remainingFraction = remaining / total;
	return {
		id: `minimax-coding-plan-${spec.id}`,
		label: "MiniMax Coding Plan",
		scope: {
			provider,
			modelId: model.model_name,
			windowId: spec.id,
		},
		window: {
			id: spec.id,
			label: spec.label,
			resetsAt: nowMs + Math.max(0, resetOffsetMs),
		},
		amount: {
			used,
			limit: total,
			remaining,
			usedFraction,
			remainingFraction,
			unit: "requests",
		},
		status: remainingFraction <= 0 ? "exhausted" : remainingFraction <= 0.2 ? "warning" : "ok",
	};
}

function worstRemainingFraction(model: MiniMaxModelRemain, semantics: MiniMaxCountSemantics): number {
	let worst = Number.POSITIVE_INFINITY;
	for (const spec of WINDOW_SPECS) {
		const total = spec.getTotal(model);
		const rawCount = spec.getCount(model);
		if (!isFiniteNumber(total) || !isFiniteNumber(rawCount) || total <= 0) continue;
		const { remaining } = normalizeCounts(total, rawCount, semantics);
		worst = Math.min(worst, remaining / total);
	}
	return worst;
}

function selectCanonicalModel(
	models: MiniMaxModelRemain[],
	semantics: MiniMaxCountSemantics,
): MiniMaxModelRemain | undefined {
	const wildcard = models.find(model => model.model_name.trim().toLowerCase() === "minimax-m*");
	if (wildcard && Number.isFinite(worstRemainingFraction(wildcard, semantics))) return wildcard;
	return [...models].sort((left, right) => {
		const remainingDiff = worstRemainingFraction(left, semantics) - worstRemainingFraction(right, semantics);
		if (remainingDiff !== 0) return remainingDiff;
		return left.model_name.localeCompare(right.model_name);
	})[0];
}

function resolveProviderConfig(provider: string): { url: string; semantics: MiniMaxCountSemantics } | undefined {
	if (provider === "minimax-code") return { url: MINIMAX_INTL_QUOTA_URL, semantics: "remaining" };
	if (provider === "minimax-code-cn") return { url: MINIMAX_CN_QUOTA_URL, semantics: "used" };
	return undefined;
}

/**
 * MiniMax Coding Plan usage provider.
 *
 * Adapted from slkiser/opencode-quota's MiniMax quota integration. The
 * international endpoint reports remaining request counts; the China endpoint
 * reports used request counts, so both are normalized into shared UsageReport
 * request limits for `/usage`.
 */
async function fetchMiniMaxCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const config = resolveProviderConfig(params.provider);
	if (!config || params.credential.type !== "api_key" || !params.credential.apiKey) return null;

	const response = await ctx.fetch(config.url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${params.credential.apiKey}`,
			"User-Agent": USER_AGENT,
		},
		signal: params.signal,
	});
	if (!response.ok) {
		ctx.logger?.debug("MiniMax usage API returned non-OK status", {
			provider: params.provider,
			status: response.status,
		});
		return null;
	}

	const payload = (await response.json()) as MiniMaxApiResponse;
	if (payload.base_resp?.status_code !== 0) {
		ctx.logger?.debug("MiniMax usage API returned application error", {
			provider: params.provider,
			status: payload.base_resp?.status_code,
			message: payload.base_resp?.status_msg,
		});
		return null;
	}

	const models = (payload.model_remains ?? []).filter(
		(model): model is MiniMaxModelRemain => isMiniMaxModelRecord(model) && isMiniMaxCodingModel(model.model_name),
	);
	const canonicalModel = selectCanonicalModel(models, config.semantics);
	if (!canonicalModel) return null;

	const nowMs = Date.now();
	const limits = WINDOW_SPECS.map(spec =>
		buildLimit(params.provider as MiniMaxProvider, canonicalModel, spec, config.semantics, nowMs),
	).filter((limit): limit is UsageLimit => limit !== undefined);
	if (limits.length === 0) return null;

	return {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata: {
			model: canonicalModel.model_name,
		},
		raw: payload,
	};
}

export const minimaxCodeUsageProvider: UsageProvider = {
	id: "minimax-code",
	fetchUsage: fetchMiniMaxCodeUsage,
	supports: (params: UsageFetchParams) =>
		(params.provider === "minimax-code" || params.provider === "minimax-code-cn") &&
		params.credential.type === "api_key",
};

export const minimaxCodeCnUsageProvider: UsageProvider = {
	id: "minimax-code-cn",
	fetchUsage: fetchMiniMaxCodeUsage,
	supports: (params: UsageFetchParams) =>
		(params.provider === "minimax-code" || params.provider === "minimax-code-cn") &&
		params.credential.type === "api_key",
};
