import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { isDeepSeekDirectEndpoint } from "../providers/openai-shared";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const BALANCE_PATH = "/user/balance";

interface DeepSeekBalanceInfo {
	currency: string;
	totalBalance: number;
}

function parseBalanceAmount(value: unknown): number | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const amount = Number(value);
	return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function parseBalanceInfo(value: unknown): DeepSeekBalanceInfo | null {
	if (!isRecord(value) || typeof value.currency !== "string" || value.currency.trim().length === 0) return null;
	const totalBalance = parseBalanceAmount(value.total_balance);
	const grantedBalance = parseBalanceAmount(value.granted_balance);
	const toppedUpBalance = parseBalanceAmount(value.topped_up_balance);
	if (totalBalance === undefined || grantedBalance === undefined || toppedUpBalance === undefined) return null;
	return {
		currency: value.currency.trim().toUpperCase(),
		totalBalance,
	};
}

function resolveBalanceEndpoint(params: UsageFetchParams): string | null {
	const baseUrl = params.baseUrl?.trim() || DEFAULT_DEEPSEEK_BASE_URL;
	if (!isDeepSeekDirectEndpoint(baseUrl)) return null;
	try {
		return `${new URL(baseUrl).origin}${BALANCE_PATH}`;
	} catch {
		return null;
	}
}

function supportsDeepSeekUsage(params: UsageFetchParams): boolean {
	return (
		params.provider === "deepseek" &&
		params.credential.type === "api_key" &&
		Boolean(params.credential.apiKey) &&
		resolveBalanceEndpoint(params) !== null
	);
}

function parseBalanceReport(payload: unknown, params: UsageFetchParams, endpoint: string): UsageReport | null {
	if (!isRecord(payload) || typeof payload.is_available !== "boolean" || !Array.isArray(payload.balance_infos)) {
		return null;
	}
	if (payload.balance_infos.length === 0) return null;
	const currencies = new Set<string>();
	const limits: UsageLimit[] = [];
	for (const rawBalance of payload.balance_infos) {
		const balance = parseBalanceInfo(rawBalance);
		if (!balance) return null;
		if (currencies.has(balance.currency)) return null;
		currencies.add(balance.currency);
		limits.push({
			id: `deepseek:balance:${balance.currency.toLowerCase()}`,
			label: `DeepSeek Balance (${balance.currency})`,
			scope: { provider: params.provider, shared: true },
			amount: {
				remaining: balance.totalBalance,
				unit: balance.currency === "USD" ? "usd" : "unknown",
			},
			status: !payload.is_available || balance.totalBalance <= 0 ? "exhausted" : "ok",
		});
	}
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint, isAvailable: payload.is_available },
		raw: payload,
	};
}

async function fetchDeepSeekUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (!supportsDeepSeekUsage(params)) return null;
	const endpoint = resolveBalanceEndpoint(params);
	const apiKey = params.credential.apiKey;
	if (!endpoint || !apiKey) return null;
	try {
		const response = await ctx.fetch(endpoint, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("DeepSeek balance fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		return parseBalanceReport(await response.json(), params, endpoint);
	} catch (error) {
		ctx.logger?.warn("DeepSeek balance fetch error", { error: String(error) });
		return null;
	}
}

export const deepseekUsageProvider: UsageProvider = {
	id: "deepseek",
	fetchUsage: fetchDeepSeekUsage,
	supports: supportsDeepSeekUsage,
	validatesCredentials: true,
	retainLastGoodOnFailure: false,
};
