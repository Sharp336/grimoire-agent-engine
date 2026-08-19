/**
 * Ollama Web Search Provider
 *
 * Calls Ollama's hosted web search REST API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 * Endpoint: POST https://ollama.com/api/web_search
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

interface OllamaSearchResult {
	title?: unknown;
	url?: unknown;
	content?: unknown;
}

interface OllamaSearchResponse {
	results?: unknown;
}

/** Read response body up to a byte cap, truncating if the limit is exceeded. */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
	const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
	if (!reader) {
		const text = await response.text();
		return text.length > maxBytes ? text.slice(0, maxBytes) : text;
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > maxBytes) {
			const remaining = maxBytes - total;
			if (remaining > 0) chunks.push(value.slice(0, remaining));
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}

	return new TextDecoder().decode(chunks.length === 0 ? new Uint8Array() : await new Blob(chunks).arrayBuffer());
}

/** Extract a string field from a loosely-typed result object. */
function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Call the Ollama web search API. */
async function callOllamaSearch(
	apiKey: string,
	query: string,
	maxResults: number,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
	timeoutMs?: number,
): Promise<OllamaSearchResponse> {
	const response = await fetchImpl(OLLAMA_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ query, max_results: maxResults }),
		signal: withHardTimeout(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await readLimitedText(response, MAX_ERROR_BYTES);
		const classified = classifyProviderHttpError("ollama", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("ollama", `Ollama API error (${response.status}): ${errorText}`, response.status);
	}

	const raw = await readLimitedText(response, MAX_RESPONSE_BYTES);
	try {
		return JSON.parse(raw) as OllamaSearchResponse;
	} catch {
		throw new SearchProviderError("ollama", "Ollama API returned invalid JSON", 500);
	}
}

/** Map Ollama results array to unified SearchSource[]. */
function toSearchSources(response: OllamaSearchResponse, numResults: number): SearchSource[] {
	const sources: SearchSource[] = [];
	if (!Array.isArray(response.results)) return sources;

	for (const value of response.results) {
		if (typeof value !== "object" || value === null) continue;
		const result = value as OllamaSearchResult;
		const url = asString(result.url);
		if (!url) continue;
		const title = asString(result.title) ?? url;
		const snippet = asString(result.content);
		sources.push({ title, url, snippet, publishedDate: undefined, ageSeconds: undefined });
	}

	return sources.slice(0, numResults);
}

/** Execute Ollama web search. */
export async function searchOllama(params: SearchParamsWithFetch): Promise<SearchResponse> {
	const keyOrResolver: ApiKey = params.authStorage.resolver("ollama-cloud", {
		sessionId: params.sessionId,
	});

	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const fetchImpl = params.fetch;

	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives
		? formatQuery(parsed, { phrases: true, negation: true, site: true })
		: params.query;

	const data = await withAuth(
		keyOrResolver,
		key => callOllamaSearch(key, query, numResults, params.signal, fetchImpl, params.timeoutMs),
		{
			signal: params.signal,
			missingKeyMessage:
				'Ollama Cloud credentials not found. Set OLLAMA_CLOUD_API_KEY or configure an API key for provider "ollama-cloud".',
		},
	);

	return {
		provider: "ollama",
		sources: toSearchSources(data, numResults),
		authMode: "api_key",
	};
}

/** Search provider for Ollama web search. */
export class OllamaProvider extends SearchProvider {
	readonly id = "ollama" as const;
	readonly label = "Ollama";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("ollama-cloud") || !!getEnvApiKey("ollama-cloud");
	}

	/**
	 * Ollama's hosted search requires an API key, but explicit selection should
	 * always route through the adapter (surfacing a clear auth error) rather
	 * than silently falling back to another provider.
	 */
	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchOllama(params);
	}
}
