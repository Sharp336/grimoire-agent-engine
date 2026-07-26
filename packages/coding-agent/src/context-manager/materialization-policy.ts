import type { Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import type { ContextSessionRuntimeRecord } from "./types";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_EXECUTE_THRESHOLD_PERCENT = 80;

export interface ContextCachePolicy {
	readonly modelKey: string;
	readonly contextLimit: number;
	readonly cacheTtlMs: number;
	readonly executeThresholdPercent: number;
	readonly executeThresholdTokens: number;
}

export interface ContextMaterializationDecision {
	readonly action: "none" | "defer" | "execute";
	readonly reason: "no-pending" | "cache-ttl" | "token-threshold";
	readonly eligibleAt?: number;
}

function resolveModelMapValue<T>(values: Readonly<Record<string, T>>, model: Model | undefined): T | undefined {
	if (!model) return values.default;
	const fullKey = `${model.provider}/${model.id}`.toLowerCase();
	const modelId = model.id.toLowerCase();
	const provider = model.provider.toLowerCase();
	for (const key of [fullKey, modelId, provider]) {
		const exact = Object.entries(values).find(([candidate]) => candidate.toLowerCase() === key);
		if (exact) return exact[1];
	}
	const patterns = Object.entries(values)
		.filter(([key]) => key !== "default" && /[*?[]/.test(key))
		.sort(([left], [right]) => right.replace(/[*?[\]]/g, "").length - left.replace(/[*?[\]]/g, "").length);
	for (const [pattern, value] of patterns) {
		try {
			const glob = new Bun.Glob(pattern.toLowerCase());
			if (glob.match(fullKey) || glob.match(modelId)) return value;
		} catch {
			// Invalid project/user patterns are ignored in favor of the default.
		}
	}
	return values.default;
}

export function parseContextCacheTtl(value: string | undefined): number {
	if (!value) return DEFAULT_CACHE_TTL_MS;
	const unitMs: Readonly<Record<string, number>> = {
		ms: 1,
		s: 1000,
		m: 60 * 1000,
		h: 60 * 60 * 1000,
		d: 24 * 60 * 60 * 1000,
		w: 7 * 24 * 60 * 60 * 1000,
	};
	let total = 0;
	let cursor = 0;
	for (const match of value.trim().matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)) {
		if (match.index !== cursor) return DEFAULT_CACHE_TTL_MS;
		total += Number(match[1]) * unitMs[match[2]];
		cursor = match.index + match[0].length;
	}
	return cursor === value.trim().length && Number.isFinite(total)
		? Math.max(0, Math.floor(total))
		: DEFAULT_CACHE_TTL_MS;
}

export function resolveContextCachePolicy(settings: Settings, model: Model | undefined): ContextCachePolicy {
	const contextLimit = Math.max(0, Math.floor(model?.contextWindow ?? 0));
	const rawPercent = resolveModelMapValue(settings.get("contextManager.executeThresholdPercent"), model) ?? 65;
	const executeThresholdPercent = Math.min(MAX_EXECUTE_THRESHOLD_PERCENT, Math.max(1, rawPercent));
	const configuredTokens = resolveModelMapValue(settings.get("contextManager.executeThresholdTokens"), model);
	const percentageTokens = contextLimit > 0 ? Math.floor((contextLimit * executeThresholdPercent) / 100) : 0;
	const executeThresholdTokens =
		configuredTokens !== undefined && Number.isFinite(configuredTokens) && configuredTokens > 0
			? contextLimit > 0
				? Math.min(Math.floor(configuredTokens), Math.floor(contextLimit * 0.8))
				: Math.floor(configuredTokens)
			: percentageTokens;
	return {
		modelKey: model ? `${model.provider}/${model.id}` : "unknown",
		contextLimit,
		cacheTtlMs: parseContextCacheTtl(resolveModelMapValue(settings.get("contextManager.cacheTtl"), model)),
		executeThresholdPercent,
		executeThresholdTokens,
	};
}

export function decideContextMaterialization(
	runtime: ContextSessionRuntimeRecord | undefined,
	hasPending: boolean,
	now = Date.now(),
): ContextMaterializationDecision {
	if (!hasPending) return { action: "none", reason: "no-pending" };
	if (runtime && runtime.executeThresholdTokens > 0 && runtime.totalTokens >= runtime.executeThresholdTokens) {
		return { action: "execute", reason: "token-threshold" };
	}
	const cacheTtlMs = runtime?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const cacheEpoch = runtime?.lastMaterializedAt ?? runtime?.pendingSince ?? runtime?.updatedAt ?? now;
	const eligibleAt = cacheEpoch + cacheTtlMs;
	return now >= eligibleAt
		? { action: "execute", reason: "cache-ttl" }
		: { action: "defer", reason: "cache-ttl", eligibleAt };
}
