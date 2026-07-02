/**
 * You.com Web Search Provider
 *
 * Uses You.com's agent-focused search API to return structured web and news
 * results.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const YDC_SEARCH_URL = "https://api.you.com/v1/agents/search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;

export interface YouSearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

interface YouWebResult {
	url?: string | null;
	title?: string | null;
	description?: string | null;
	snippets?: string[] | null;
	page_age?: string | null;
	authors?: string[] | null;
}

interface YouNewsResult {
	url?: string | null;
	title?: string | null;
	description?: string | null;
	page_age?: string | null;
}

interface YouSearchResponse {
	results?: {
		web?: YouWebResult[] | null;
		news?: YouNewsResult[] | null;
	} | null;
	metadata?: {
		search_uuid?: string | null;
		query?: string | null;
	} | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

function getErrorMessage(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	const record = asRecord(value);
	if (!record) return null;

	for (const key of ["detail", "error", "message"]) {
		const message = getErrorMessage(record[key]);
		if (message) return message;
	}

	return null;
}

/** Exported for testing. Builds the You.com request body from unified params. */
export function buildRequestBody(params: YouSearchParams): Record<string, unknown> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	// `count` is You.com's per-section (web/news) result cap. Recency maps to the
	// orthogonal `freshness` temporal filter and is only sent when requested,
	// keeping the default corpus intact for technical queries.
	const body: Record<string, unknown> = {
		query: params.query,
		count: numResults,
	};
	if (params.recency) {
		body.freshness = params.recency;
	}
	return body;
}

async function callYouSearch(apiKey: string, params: YouSearchParams): Promise<YouSearchResponse> {
	const response = await (params.fetch ?? fetch)(YDC_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			// You.com's public API endpoint trips Bun's response decompression;
			// request an uncompressed body to keep parsing reliable.
			"Accept-Encoding": "identity",
			"X-API-Key": apiKey,
		},
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("ydc", response.status, errorText);
		if (classified) throw classified;
		let message = errorText.trim();
		if (message.length === 0) {
			message = response.statusText;
		} else {
			try {
				message = getErrorMessage(JSON.parse(errorText)) ?? message;
			} catch {
				// Keep raw text fallback.
			}
		}
		throw new SearchProviderError("ydc", `You.com API error (${response.status}): ${message}`, response.status);
	}

	return (await response.json()) as YouSearchResponse;
}

function toSearchResponse(response: YouSearchResponse, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];

	for (const result of response.results?.web ?? []) {
		if (!result.url) continue;
		const snippetParts: string[] = [];
		if (result.description) snippetParts.push(result.description);
		if (result.snippets?.length) snippetParts.push(...result.snippets);
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: snippetParts.length > 0 ? snippetParts.join("\n") : undefined,
			publishedDate: result.page_age ?? undefined,
			ageSeconds: dateToAgeSeconds(result.page_age ?? undefined),
			author: result.authors?.[0] ?? undefined,
		});
	}

	for (const result of response.results?.news ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.description ?? undefined,
			publishedDate: result.page_age ?? undefined,
			ageSeconds: dateToAgeSeconds(result.page_age ?? undefined),
		});
	}

	return {
		provider: "ydc",
		sources: sources.slice(0, numResults),
		requestId: response.metadata?.search_uuid ?? undefined,
		authMode: "api_key",
	};
}

/** Execute You.com web search. */
export async function searchYou(params: SearchParams): Promise<SearchResponse> {
	const youParams: YouSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		fetch: params.fetch,
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("ydc", {
		sessionId: params.sessionId,
	});

	const numResults = clampNumResults(youParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await withAuth(keyOrResolver, key => callYouSearch(key, youParams), {
		signal: params.signal,
		missingKeyMessage: 'You.com credentials not found. Set YDC_API_KEY or configure an API key for provider "ydc".',
	});

	return toSearchResponse(response, numResults);
}

/** Search provider for You.com web search. */
export class YouProvider extends SearchProvider {
	readonly id = "ydc";
	readonly label = "You.com";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("ydc") || !!getEnvApiKey("ydc");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchYou(params);
	}
}
