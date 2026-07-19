import { $env } from "@oh-my-pi/pi-utils/env";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { FetchImpl } from "../types";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { toNumber } from "./shared";

const DEFAULT_DEVIN_API_BASE_URL = "https://api.devin.ai";
const DEVIN_API_KEY_PREFIX = "cog_";

export interface DevinUsageQuery {
	/** Unix seconds, Unix milliseconds, or a Date passed through as `time_after`. */
	timeAfter?: number | Date;
	/** Unix seconds, Unix milliseconds, or a Date passed through as `time_before`. */
	timeBefore?: number | Date;
}

export interface DevinUsageAuth extends DevinUsageQuery {
	apiKey?: string;
	baseUrl?: string;
	orgId?: string;
	fetch: FetchImpl;
	signal?: AbortSignal;
}

export interface DevinConsumptionEntry {
	/** Day boundary as returned by Devin, normalized to Unix milliseconds when parseable. */
	date?: number;
	/** YYYY-MM-DD rendering of `date`, when parseable. */
	day?: string;
	acus: number;
	acusByProduct: Record<string, number>;
}

export interface DevinConsumptionSummary {
	totalAcus: number;
	entries: DevinConsumptionEntry[];
	acusByProduct: Record<string, number>;
	endpoint: string;
	raw: unknown;
}

export interface DevinUsageMetrics {
	sessionsCount?: number;
	searchesCount?: number;
	prsCreatedCount?: number;
	prsMergedCount?: number;
	endpoint: string;
	raw: unknown;
}

interface FetchJsonResult {
	url: string;
	payload: unknown;
}

interface DevinHttpFailure {
	url: string;
	status: number;
	body: string;
}

class DevinUsageRequestError extends Error {
	readonly url: string;
	readonly status: number;

	constructor(label: string, failure: DevinHttpFailure) {
		super(`Devin ${label} request failed: ${failure.status} ${failure.body}`.trim());
		this.name = "DevinUsageRequestError";
		this.url = failure.url;
		this.status = failure.status;
	}
}

function isDevinAuthFailure(error: unknown): boolean {
	return error instanceof DevinUsageRequestError && (error.status === 401 || error.status === 403);
}

function normalizeBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_DEVIN_API_BASE_URL;
	try {
		const parsed = new URL(trimmed);
		// OMP's Devin chat provider talks to the Codeium/Cascade Connect endpoint;
		// public usage lives on api.devin.ai.
		if (parsed.hostname === "server.codeium.com") return DEFAULT_DEVIN_API_BASE_URL;
	} catch {
		return DEFAULT_DEVIN_API_BASE_URL;
	}
	return trimmed.replace(/\/+$/, "");
}

function normalizeDevinApiKey(apiKey: string | undefined): string | undefined {
	const trimmed = apiKey?.trim();
	return trimmed?.startsWith(DEVIN_API_KEY_PREFIX) ? trimmed : undefined;
}

function toUnixSeconds(value: number | Date | undefined): number | undefined {
	if (value === undefined) return undefined;
	const millis = value instanceof Date ? value.getTime() : value > 1_000_000_000_000 ? value : value * 1000;
	if (!Number.isFinite(millis)) return undefined;
	return Math.floor(millis / 1000);
}

function withUsageQuery(url: string, query: DevinUsageQuery): string {
	const parsed = new URL(url);
	const timeAfter = toUnixSeconds(query.timeAfter);
	const timeBefore = toUnixSeconds(query.timeBefore);
	if (timeAfter !== undefined) parsed.searchParams.set("time_after", String(timeAfter));
	if (timeBefore !== undefined) parsed.searchParams.set("time_before", String(timeBefore));
	return parsed.toString();
}

function readOrgId(auth: Pick<DevinUsageAuth, "orgId">): string | undefined {
	return auth.orgId?.trim() || $env.DEVIN_USAGE_ORG_ID?.trim() || $env.DEVIN_ORG_ID?.trim() || undefined;
}

async function discoverDevinOrgId(
	apiKey: string,
	baseUrl: string | undefined,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const url = `${normalizeBaseUrl(baseUrl)}/v3/self`;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal,
		});
	} catch {
		throw new Error("Devin profile request failed before response");
	}

	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new DevinUsageRequestError("profile", {
				url,
				status: response.status,
				body: await response.text(),
			});
		}
		return undefined;
	}

	try {
		const data = await response.json();
		if (isRecord(data)) {
			const discovered =
				typeof data.org_id === "string" ? data.org_id : typeof data.orgId === "string" ? data.orgId : undefined;
			return discovered?.trim() || undefined;
		}
	} catch {
		// Ignore JSON parse errors for discovery and yield no org
	}
	return undefined;
}
function buildConsumptionPaths(orgId: string | undefined): string[] {
	if (!orgId) return ["/v3/enterprise/consumption/daily"];
	const encoded = encodeURIComponent(orgId);
	return [
		`/v3/organizations/${encoded}/consumption/daily`,
		`/v3/enterprise/consumption/daily/organizations/${encoded}`,
	];
}

function buildMetricsPaths(orgId: string | undefined): string[] {
	if (!orgId) return ["/v3/enterprise/metrics/usage"];
	const encoded = encodeURIComponent(orgId);
	return [`/v3/organizations/${encoded}/metrics/usage`, `/v3/enterprise/organizations/${encoded}/metrics/usage`];
}

async function fetchFirstJson(auth: DevinUsageAuth, paths: string[], label: string): Promise<FetchJsonResult | null> {
	const token = normalizeDevinApiKey(auth.apiKey);
	if (!token) return null;
	const baseUrl = normalizeBaseUrl(auth.baseUrl);
	let lastFailure: DevinHttpFailure | undefined;
	let firstAuthFailure: DevinHttpFailure | undefined;
	for (const path of paths) {
		const url = withUsageQuery(`${baseUrl}${path}`, auth);
		let response: Response;
		try {
			response = await auth.fetch(url, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
				signal: auth.signal,
			});
		} catch {
			throw new Error(`Devin ${label} request failed before response`);
		}

		if (!response.ok) {
			const failure = { url, status: response.status, body: await response.text() };
			if (!firstAuthFailure && (failure.status === 401 || failure.status === 403)) {
				firstAuthFailure = failure;
			}
			lastFailure = failure;
			continue;
		}

		try {
			return { url, payload: await response.json() };
		} catch {
			lastFailure = { url, status: response.status, body: "invalid JSON response" };
		}
	}

	if (firstAuthFailure) {
		throw new DevinUsageRequestError(label, firstAuthFailure);
	}

	if (lastFailure) {
		throw new DevinUsageRequestError(label, lastFailure);
	}
	return null;
}

function parseDateMillis(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1_000_000_000_000 ? value : value * 1000;
	}
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function formatDay(dateMs: number | undefined): string | undefined {
	if (dateMs === undefined || !Number.isFinite(dateMs)) return undefined;
	return new Date(dateMs).toISOString().slice(0, 10);
}

function parseAcusByProduct(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const parsed: Record<string, number> = {};
	for (const [product, raw] of Object.entries(value)) {
		const acus = toNumber(raw);
		if (acus === undefined) continue;
		parsed[product] = acus;
	}
	return parsed;
}

function parseConsumptionEntry(value: unknown): DevinConsumptionEntry | null {
	if (!isRecord(value)) return null;
	const acus = toNumber(value.acus);
	if (acus === undefined) return null;
	const date = parseDateMillis(value.date);
	return {
		...(date !== undefined ? { date, day: formatDay(date) } : {}),
		acus,
		acusByProduct: parseAcusByProduct(value.acus_by_product),
	};
}

function sumProductTotals(entries: DevinConsumptionEntry[]): Record<string, number> {
	const totals = new Map<string, number>();
	for (const entry of entries) {
		for (const [product, acus] of Object.entries(entry.acusByProduct)) {
			totals.set(product, (totals.get(product) ?? 0) + acus);
		}
	}
	return Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function parseConsumptionPayload(payload: unknown, endpoint: string): DevinConsumptionSummary | null {
	if (!isRecord(payload)) return null;
	const entries = Array.isArray(payload.consumption_by_date)
		? payload.consumption_by_date
				.map(parseConsumptionEntry)
				.filter((entry): entry is DevinConsumptionEntry => entry !== null)
		: [];
	const totalFromPayload = toNumber(payload.total_acus);
	if (totalFromPayload === undefined && entries.length === 0) return null;
	const totalAcus = totalFromPayload ?? entries.reduce((sum, entry) => sum + entry.acus, 0);
	if (!Number.isFinite(totalAcus)) return null;
	return {
		totalAcus,
		entries,
		acusByProduct: sumProductTotals(entries),
		endpoint,
		raw: payload,
	};
}

function parseMetricsPayload(payload: unknown, endpoint: string): DevinUsageMetrics | null {
	if (!isRecord(payload)) return null;
	const metrics: DevinUsageMetrics = {
		sessionsCount: toNumber(payload.sessions_count),
		searchesCount: toNumber(payload.searches_count),
		prsCreatedCount: toNumber(payload.prs_created_count),
		prsMergedCount: toNumber(payload.prs_merged_count),
		endpoint,
		raw: payload,
	};
	if (
		metrics.sessionsCount === undefined &&
		metrics.searchesCount === undefined &&
		metrics.prsCreatedCount === undefined &&
		metrics.prsMergedCount === undefined
	) {
		return null;
	}
	return metrics;
}

export async function fetchDevinConsumption(auth: DevinUsageAuth): Promise<DevinConsumptionSummary | null> {
	const result = await fetchFirstJson(auth, buildConsumptionPaths(readOrgId(auth)), "consumption");
	return result ? parseConsumptionPayload(result.payload, result.url) : null;
}

export async function fetchDevinUsageMetrics(auth: DevinUsageAuth): Promise<DevinUsageMetrics | null> {
	const result = await fetchFirstJson(auth, buildMetricsPaths(readOrgId(auth)), "metrics");
	return result ? parseMetricsPayload(result.payload, result.url) : null;
}

function formatProductName(product: string): string {
	return product
		.split(/[-_]/g)
		.filter(Boolean)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function buildAcuLimits(
	params: UsageFetchParams,
	consumption: DevinConsumptionSummary,
	orgId: string | undefined,
): UsageLimit[] {
	const baseScope: UsageLimit["scope"] = { provider: params.provider };
	if (params.credential.accountId) {
		baseScope.accountId = params.credential.accountId;
	}
	if (orgId) {
		baseScope.orgId = orgId;
	}
	const limits: UsageLimit[] = [
		{
			id: "devin:acus:total",
			label: "Devin ACU consumption",
			scope: { ...baseScope, shared: true },
			amount: { used: consumption.totalAcus, unit: "acus" },
			status: "ok",
		},
	];

	for (const [product, acus] of Object.entries(consumption.acusByProduct)) {
		if (acus <= 0) continue;
		limits.push({
			id: `devin:acus:product:${product}`,
			label: `${formatProductName(product)} ACU consumption`,
			scope: { ...baseScope, tier: product },
			amount: { used: acus, unit: "acus" },
			status: "ok",
		});
	}

	return limits;
}

function metadataFromParams(
	params: UsageFetchParams,
	orgId: string | undefined,
	consumption: DevinConsumptionSummary | null,
	metrics: DevinUsageMetrics | null,
): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;
	if (params.credential.email) metadata.email = params.credential.email;
	if (orgId) metadata.orgId = orgId;
	if (consumption) {
		metadata.totalAcus = consumption.totalAcus;
		metadata.acusByProduct = consumption.acusByProduct;
		metadata.consumptionByDate = consumption.entries;
	}
	if (metrics) {
		metadata.metrics = {
			sessionsCount: metrics.sessionsCount,
			searchesCount: metrics.searchesCount,
			prsCreatedCount: metrics.prsCreatedCount,
			prsMergedCount: metrics.prsMergedCount,
		};
	}
	return metadata;
}

async function fetchDevinUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "devin") return null;
	const { credential } = params;
	const apiKey = credential.type === "api_key" ? normalizeDevinApiKey(credential.apiKey) : undefined;
	if (!apiKey) return null;

	const baseUrl = params.baseUrl ?? credential.apiEndpoint;
	let orgId = readOrgId({
		orgId: typeof credential.metadata?.orgId === "string" ? credential.metadata.orgId : undefined,
	});
	let discoveryError: unknown = null;

	if (!orgId) {
		try {
			orgId = await discoverDevinOrgId(apiKey, baseUrl, ctx.fetch, params.signal);
		} catch (error) {
			discoveryError = error;
			ctx.logger?.debug("Devin org discovery failed", { provider: params.provider, error: String(error) });
		}
	}

	const auth: DevinUsageAuth = {
		apiKey,
		baseUrl,
		orgId,
		fetch: ctx.fetch,
		signal: params.signal,
	};

	let consumption: DevinConsumptionSummary | null = null;
	let consumptionError: unknown = null;
	try {
		consumption = await fetchDevinConsumption(auth);
	} catch (error) {
		consumptionError = error;
	}

	let metrics: DevinUsageMetrics | null = null;
	let metricsError: unknown = null;
	try {
		metrics = await fetchDevinUsageMetrics(auth);
	} catch (error) {
		metricsError = error;
	}

	if (!consumption && !metrics) {
		if (isDevinAuthFailure(consumptionError)) {
			throw consumptionError;
		}
		if (isDevinAuthFailure(metricsError)) {
			throw metricsError;
		}
		if (isDevinAuthFailure(discoveryError)) {
			throw discoveryError;
		}
		if (consumptionError) {
			ctx.logger?.warn("Devin consumption request failed", {
				provider: params.provider,
				error: String(consumptionError),
			});
		}
		if (metricsError) {
			ctx.logger?.debug("Devin metrics request failed", { provider: params.provider, error: String(metricsError) });
		}
		return null;
	}

	if (!consumption && consumptionError) {
		ctx.logger?.warn("Devin consumption request failed", {
			provider: params.provider,
			error: String(consumptionError),
		});
	}
	if (!metrics && metricsError) {
		ctx.logger?.debug("Devin metrics request failed", { provider: params.provider, error: String(metricsError) });
	}
	const limits = consumption ? buildAcuLimits(params, consumption, orgId) : [];
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		...(consumption
			? undefined
			: { notes: ["Devin usage metrics were available, but ACU consumption was unavailable."] }),
		metadata: metadataFromParams(params, orgId, consumption, metrics),
		raw: {
			consumption: consumption?.raw,
			metrics: metrics?.raw,
		},
	};
}

function isDevinApiKeyLike(key: string): boolean {
	const trimmed = key.trim();
	if (trimmed.startsWith(DEVIN_API_KEY_PREFIX)) return true;
	if (trimmed.startsWith("!")) return true;
	if (/^[A-Z_0-9]+$/.test(trimmed)) return true;
	return false;
}

export const devinUsageProvider: UsageProvider = {
	id: "devin",
	fetchUsage: fetchDevinUsage,
	supports: params =>
		params.provider === "devin" &&
		params.credential.type === "api_key" &&
		!!params.credential.apiKey &&
		isDevinApiKeyLike(params.credential.apiKey),
	validatesCredentials: true,
};
