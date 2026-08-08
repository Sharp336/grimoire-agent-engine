import { ProviderHttpError } from "../error";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { parseIsoTimestamp, usageStatus } from "./shared";

const PROVIDER = "neuralwatt";
const DEFAULT_BASE_URL = "https://api.neuralwatt.com/v1";
const DEFAULT_OVERAGE_LIMIT_USD = 100;

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
function buildUsageAmount(
	used: number | undefined,
	limit: number | undefined,
	remaining: number | undefined,
	unit: UsageAmount["unit"],
): UsageAmount | null {
	if (used === undefined && limit === undefined && remaining === undefined) return null;
	const resolvedUsed = used ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
	const usedFraction =
		limit !== undefined && limit > 0 ? (resolvedUsed !== undefined ? resolvedUsed / limit : undefined) : undefined;
	return {
		...(resolvedUsed !== undefined ? { used: resolvedUsed } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(remaining !== undefined ? { remaining } : {}),
		...(usedFraction !== undefined ? { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) } : {}),
		unit,
	};
}
function usageStatusWhileUsable(usedFraction: number | undefined) {
	const status = usageStatus(usedFraction);
	return status === "exhausted" ? "warning" : status;
}

function buildSubscriptionLimit(subscription: Record<string, unknown>): UsageLimit | null {
	const amount = buildUsageAmount(
		toFiniteNumber(subscription.kwh_used),
		toFiniteNumber(subscription.kwh_included),
		toFiniteNumber(subscription.kwh_remaining),
		"kwh",
	);
	if (!amount) return null;
	const periodStart = parseIsoTimestamp(subscription.current_period_start);
	const periodEnd =
		parseIsoTimestamp(subscription.kwh_reset_date) ?? parseIsoTimestamp(subscription.current_period_end);
	const durationMs =
		periodStart !== undefined && periodEnd !== undefined && periodEnd > periodStart
			? periodEnd - periodStart
			: undefined;
	const plan = toNonEmptyString(subscription.plan);
	const inOverage = subscription.in_overage === true;

	return {
		id: "neuralwatt:subscription",
		label: "Subscription Energy",
		scope: {
			provider: PROVIDER,
			...(plan ? { tier: plan } : {}),
			windowId: "billing",
			shared: true,
		},
		window: {
			id: "billing",
			label: "Billing Period",
			...(durationMs !== undefined ? { durationMs } : {}),
			...(periodEnd !== undefined ? { resetsAt: periodEnd } : {}),
		},
		amount,
		status: inOverage ? "warning" : usageStatusWhileUsable(amount.usedFraction),
		...(inOverage
			? { notes: ["Included energy exhausted; usage continues against credits and overage capacity."] }
			: {}),
	};
}
function buildCreditsLimit(balance: Record<string, unknown>, subscriptionOverage = false): UsageLimit | null {
	const amount = buildUsageAmount(
		toFiniteNumber(balance.credits_used_usd),
		toFiniteNumber(balance.total_credits_usd),
		toFiniteNumber(balance.credits_remaining_usd),
		"usd",
	);
	if (!amount) return null;
	return {
		id: "neuralwatt:credits",
		label: subscriptionOverage ? "Credit Balance" : "PAYG Credits",
		scope: { provider: PROVIDER, shared: true },
		amount,
		status: subscriptionOverage
			? usageStatusWhileUsable(amount.usedFraction)
			: amount.remaining !== undefined && amount.remaining <= 0
				? "exhausted"
				: usageStatus(amount.usedFraction),
	};
}

function buildOverageLimit(
	balance: Record<string, unknown>,
	rateLimits: Record<string, unknown> | undefined,
): UsageLimit | null {
	const creditBalance = toFiniteNumber(balance.credits_remaining_usd);
	if (creditBalance === undefined) return null;
	const configuredLimit = toFiniteNumber(rateLimits?.overage_limit_usd);
	const limit = configuredLimit === undefined ? DEFAULT_OVERAGE_LIMIT_USD : Math.abs(configuredLimit);
	const used = Math.max(0, -creditBalance);
	const remaining = limit - used;
	const amount = buildUsageAmount(used, limit, remaining, "usd");
	if (!amount) return null;
	return {
		id: "neuralwatt:overage",
		label: "Overage Capacity",
		scope: { provider: PROVIDER, shared: true },
		amount,
		status: creditBalance <= 0 && remaining <= 0 ? "exhausted" : "warning",
		notes: ["Requests pause when this overage capacity is exhausted."],
	};
}

function buildKeyAllowanceLimit(key: Record<string, unknown>): UsageLimit | null {
	if (!isRecord(key.allowance)) return null;
	const allowance = key.allowance;
	const amount = buildUsageAmount(
		toFiniteNumber(allowance.spent_usd),
		toFiniteNumber(allowance.limit_usd),
		toFiniteNumber(allowance.remaining_usd),
		"usd",
	);
	if (!amount) return null;
	const period = toNonEmptyString(allowance.period);
	const blocked = allowance.blocked === true;
	return {
		id: "neuralwatt:key-allowance",
		label: "API Key Allowance",
		scope: { provider: PROVIDER, windowId: period ?? "allowance", shared: true },
		...(period ? { window: { id: period, label: period.charAt(0).toUpperCase() + period.slice(1) } } : {}),
		amount,
		status: blocked ? "exhausted" : usageStatusWhileUsable(amount.usedFraction),
		...(blocked ? { notes: ["API key is blocked because its spending allowance is exhausted."] } : {}),
	};
}

async function fetchNeuralwattUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER || params.credential.type !== "api_key" || !params.credential.apiKey) return null;

	const baseUrl = (params.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
	const url = `${baseUrl}/quota`;
	try {
		const response = await ctx.fetch(url, {
			headers: { Accept: "application/json", Authorization: `Bearer ${params.credential.apiKey}` },
			signal: params.signal,
		});
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(`Neuralwatt quota endpoint returned ${response.status}`, response.status, {
					headers: response.headers,
				});
			}
			ctx.logger?.warn("Neuralwatt quota fetch failed", { status: response.status });
			return null;
		}

		const payload: unknown = await response.json();
		if (!isRecord(payload)) return null;
		const subscriptionRecord = isRecord(payload.subscription) ? payload.subscription : undefined;
		const balance = isRecord(payload.balance) ? payload.balance : undefined;
		const key = isRecord(payload.key) ? payload.key : undefined;
		const rateLimits = isRecord(payload.limits) ? payload.limits : undefined;
		const limits: UsageLimit[] = [];
		const subscription = subscriptionRecord ? buildSubscriptionLimit(subscriptionRecord) : null;
		if (subscription) {
			limits.push(subscription);
			if (subscriptionRecord?.in_overage === true && balance) {
				const credits = buildCreditsLimit(balance, true);
				if (credits) limits.push(credits);
				const overage = buildOverageLimit(balance, rateLimits);
				if (overage) limits.push(overage);
			}
		} else if (balance) {
			const credits = buildCreditsLimit(balance);
			if (credits) limits.push(credits);
		}
		if (key) {
			const allowance = buildKeyAllowanceLimit(key);
			if (allowance) limits.push(allowance);
		}
		if (limits.length === 0) return null;
		return {
			provider: PROVIDER,
			fetchedAt: Date.now(),
			limits,
			metadata: {
				endpoint: url,
				snapshotAt: toNonEmptyString(payload.snapshot_at),
				plan: toNonEmptyString(subscriptionRecord?.plan),
				status: toNonEmptyString(subscriptionRecord?.status),
				billingInterval: toNonEmptyString(subscriptionRecord?.billing_interval),
				autoRenew: typeof subscriptionRecord?.auto_renew === "boolean" ? subscriptionRecord.auto_renew : undefined,
				accountingMethod: toNonEmptyString(balance?.accounting_method),
				keyName: toNonEmptyString(key?.name),
				rateLimitTier: toNonEmptyString(rateLimits?.rate_limit_tier),
			},
			raw: payload,
		};
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Neuralwatt quota request failed", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

export const neuralwattUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchNeuralwattUsage,
	supports: params =>
		params.provider === PROVIDER && params.credential.type === "api_key" && Boolean(params.credential.apiKey),
	validatesCredentials: true,
};
