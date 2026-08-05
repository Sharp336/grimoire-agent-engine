/**
 * AnySearch Web Search Provider
 *
 * Unified search infrastructure for AI agents (https://anysearch.com/docs).
 * Posts to the `/v1/search` REST endpoint; the gateway routes the query by
 * intent, fuses sources, and re-ranks results. Supports an optional
 * `Authorization: Bearer` API key with an anonymous free tier when absent,
 * mirroring Firecrawl's keyless fallback: the auto chain only admits the
 * provider when a credential exists, while explicit selection always works.
 */
import {
	type AuthStorage,
	type FetchImpl,
	getEnvApiKey,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	withAuth,
} from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ANYSEARCH_SEARCH_URL = "https://api.anysearch.com/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

export interface AnySearchSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface AnySearchResult {
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
}

interface AnySearchMetadata {
	total_results?: number;
	search_time_ms?: number;
}

interface AnySearchData {
	results?: AnySearchResult[];
	metadata?: AnySearchMetadata;
}

interface AnySearchApiResponse {
	code?: number;
	message?: string;
	request_id?: string;
	data?: AnySearchData;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Extract the upstream `message` field from a parsed JSON body, if any. */
function getErrorMessage(value: unknown): string | null {
	const record = asRecord(value);
	return typeof record?.message === "string" && record.message.length > 0 ? record.message : null;
}

/** Find AnySearch API key through AuthStorage's unified refresh pipeline. */
export async function findApiKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	return (await authStorage.getApiKey("anysearch", sessionId, { signal })) ?? null;
}

/** Exported for testing. Builds the AnySearch request body from unified params. */
export function buildRequestBody(params: AnySearchSearchParams): Record<string, unknown> {
	return {
		query: params.query,
		max_results: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	};
}

async function callAnySearchSearch(
	apiKey: string | undefined,
	params: AnySearchSearchParams,
): Promise<AnySearchApiResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const response = await (params.fetch ?? fetch)(ANYSEARCH_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	const responseText = await response.text();

	if (!response.ok) {
		const classified = classifyProviderHttpError("anysearch", response.status, responseText);
		if (classified) throw classified;
		let message = responseText.trim();
		if (message.length === 0) {
			message = response.statusText;
		} else {
			try {
				message = getErrorMessage(JSON.parse(responseText)) ?? message;
			} catch {
				// Keep raw text fallback.
			}
		}
		throw new SearchProviderError(
			"anysearch",
			`AnySearch API error (${response.status}): ${message}`,
			response.status,
		);
	}

	let payload: AnySearchApiResponse;
	try {
		payload = JSON.parse(responseText) as AnySearchApiResponse;
	} catch {
		throw new SearchProviderError("anysearch", `AnySearch API returned invalid JSON: ${responseText}`);
	}

	// Success responses carry `code: 0`; non-zero codes (missing required
	// params for a tag, quota guard rejections, …) surface even on HTTP 200.
	if (payload.code !== undefined && payload.code !== 0) {
		throw new SearchProviderError("anysearch", `AnySearch API error: ${payload.message ?? `code ${payload.code}`}`);
	}

	return payload;
}

function toSearchResponse(
	response: AnySearchApiResponse,
	numResults: number,
	authMode: "api_key" | "keyless",
): SearchResponse {
	const sources: SearchSource[] = [];

	for (const result of response.data?.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.snippet ?? result.content ?? undefined,
		});
	}

	return {
		provider: "anysearch",
		sources: sources.slice(0, numResults),
		requestId: response.request_id ?? undefined,
		authMode,
	};
}

/** Execute AnySearch web search. */
export async function searchAnySearch(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	// AnySearch routes natural-language queries by intent; drop Google-style
	// directives (site:, before:, …) and keep only phrases/negations, which
	// survive as plain keywords for the intent router.
	const query = parsed.hasDirectives ? formatQuery(parsed, { phrases: true, negation: true }) : params.query;

	const anysearchParams: AnySearchSearchParams = {
		query,
		num_results: params.numSearchResults ?? params.limit,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	const numResults = clampNumResults(anysearchParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const keyResolver = params.authStorage.resolver("anysearch", {
		sessionId: params.sessionId,
	});
	const resolvedKey = await resolveApiKeyOnce(keyResolver, params.signal);

	let response: AnySearchApiResponse;
	if (resolvedKey) {
		// Reuse the preflight credential for the initial authenticated attempt.
		const seededResolver = seedApiKeyResolver(resolvedKey, keyResolver);
		response = await withAuth(seededResolver, key => callAnySearchSearch(key, anysearchParams), {
			signal: params.signal,
		});
	} else {
		// Anonymous tier — omit the Authorization header.
		response = await callAnySearchSearch(undefined, anysearchParams);
	}

	return toSearchResponse(response, numResults, resolvedKey ? "api_key" : "keyless");
}

/** Search provider for AnySearch web search. */
export class AnySearchProvider extends SearchProvider {
	readonly id = "anysearch";
	readonly label = "AnySearch";

	/**
	 * Auto-chain admission: requires a credential so an unconfigured AnySearch
	 * doesn't displace other providers the user has set up with API keys.
	 */
	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("anysearch") || !!getEnvApiKey("anysearch");
	}

	/**
	 * AnySearch ships a free anonymous tier, so an explicit user selection
	 * (`webSearch: anysearch`) works without any credential configured.
	 */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnySearch(params);
	}
}
