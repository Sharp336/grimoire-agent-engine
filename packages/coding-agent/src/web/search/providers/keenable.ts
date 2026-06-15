/**
 * Keenable Web Search Provider
 *
 * Uses Keenable's MCP server (works without an API key, 1,000 req/hr free).
 * Set KEENABLE_API_KEY for higher rate limits.
 */

import { type AuthStorage, type FetchImpl, getEnvApiKey } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

const KEENABLE_MCP_URL = "https://api.keenable.ai/mcp";

interface KeenableMcpContent {
	type: string;
	text?: string;
}

interface KeenableMcpResult {
	result?: {
		content?: KeenableMcpContent[];
	};
	error?: { code: number; message: string };
}

/** Individual Keenable search result from JSON format. */
interface JsonSearchResult {
	title?: string;
	url?: string;
	description?: string;
	snippet?: string;
	published_at?: string;
}

/** Wrapper response with a `results` array. */
interface JsonSearchResponse {
	query?: string;
	results?: JsonSearchResult[];
}

/** @visible_for_testing */
export function recencyToDate(recency?: "day" | "week" | "month" | "year"): string | undefined {
	const now = Date.now();
	switch (recency) {
		case "day": return new Date(now - 86_400_000).toISOString().slice(0, 10);
		case "week": return new Date(now - 604_800_000).toISOString().slice(0, 10);
		case "month": return new Date(now - 2_592_000_000).toISOString().slice(0, 10);
		case "year": return new Date(now - 31_536_000_000).toISOString().slice(0, 10);
		default: return undefined;
	}
}

/**
 * Execute a full MCP session (initialize + initialized + tools/call) for a single search.
 */
async function callKeenableMcpSearch(
	query: string,
	publishedAfter: string | undefined,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<string> {
	const timeoutSignal = withHardTimeout(signal);

	async function mcpPost(body: unknown, sessionId?: string): Promise<{ data: KeenableMcpResult; sessionId: string | null }> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (apiKey) {
			headers["X-API-Key"] = apiKey;
		}
		if (sessionId) {
			headers["Mcp-Session-Id"] = sessionId;
		}
		const resp = await fetchImpl(KEENABLE_MCP_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: timeoutSignal,
		});

		const sessionId_ = resp.headers.get("Mcp-Session-Id");

		// MCP Streamable HTTP: notifications/initialized and empty responses may
		// return 202 with no body, or responses may come as text/event-stream.
		// Handle gracefully instead of forcing JSON parsing on every response.
		const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
		const bodyText = await resp.text();

		if (!resp.ok) {
			throw new SearchProviderError(
				"keenable",
				`MCP error (${resp.status}): ${bodyText || "(empty body)"}`,
				resp.status,
			);
		}

		// For empty bodies (e.g. 202 Accepted from notifications), return empty.
		if (!bodyText) {
			return { data: {}, sessionId: sessionId_ };
		}

		// For SSE responses, extract JSON from data: lines.
		if (contentType.includes("text/event-stream")) {
			const sseData = parseSseBody(bodyText);
			if (sseData) {
				try {
					const parsed = JSON.parse(sseData) as KeenableMcpResult;
					if (parsed.error) {
						throw new SearchProviderError("keenable", `MCP error: ${parsed.error.message}`, parsed.error.code);
					}
					return { data: parsed, sessionId: sessionId_ };
				} catch {
					// Fall through to empty result
				}
			}
			return { data: {}, sessionId: sessionId_ };
		}

		let data: KeenableMcpResult;
		try {
			data = JSON.parse(bodyText) as KeenableMcpResult;
		} catch {
			data = {};
		}

		if (data.error) {
			throw new SearchProviderError(
				"keenable",
				`MCP error: ${data.error.message}`,
				data.error.code,
			);
		}

		return { data, sessionId: sessionId_ };
	}

	// Step 1: initialize handshake
	const init = await mcpPost({
		jsonrpc: "2.0",
		id: "init",
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "omp-keenable", version: "1.0" },
		},
	});
	if (!init.sessionId) {
		throw new SearchProviderError("keenable", "MCP server did not return a session ID", 500);
	}

	// Step 2: initialized notification (fire-and-forget, may return 202 with no body)
	await mcpPost({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	}, init.sessionId);

	// Step 3: call search_web_pages
	const args: Record<string, string> = { query };
	if (publishedAfter) {
		args.published_after = publishedAfter;
	}

	const search = await mcpPost({
		jsonrpc: "2.0",
		id: "search",
		method: "tools/call",
		params: {
			name: "search_web_pages",
			arguments: args,
		},
	}, init.sessionId);

	const content = search.data?.result?.content;
	if (!content || content.length === 0) {
		return "";
	}
	return content.map(c => c.text ?? "").join("\n");
}

/** Convert Keenable JSON results to SearchSource[]. */
/** Extract JSON payload from SSE body (strips data: prefix, joins multi-line). */
function parseSseBody(body: string): string | undefined {
	const dataLines: string[] = [];
	for (const line of body.split("\n")) {
		if (line.startsWith("data: ")) {
			dataLines.push(line.slice(6));
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5));
		}
	}
	if (dataLines.length === 0) return undefined;
	return dataLines.join("\n");
}
/** Convert Keenable JSON results to SearchSource[]. */
function parseJsonResults(results: JsonSearchResult[]): SearchSource[] {
	const sources: SearchSource[] = [];
	for (const r of results) {
		if (!r.url) continue;
		sources.push({
			title: r.title ?? r.url,
			url: r.url,
			snippet: r.snippet ?? r.description ?? undefined,
			publishedDate: r.published_at ?? undefined,
		});
	}
	return sources;
}

/**
 * Parse Keenable's MCP response into SearchSource[].
 *
 * Handles two formats:
 *   1. JSON structure: [{ title, url, description, published_at }]
 *   2. Text format with "Title:", "URL:", "Published:" fields separated by "---"
 */
export function parseKeenableResponse(text: string): SearchSource[] {
	// Try parsing as JSON first (defensive — current MCP returns text format,
	// but JSON responses are documented and may be returned in the future).
	const trimmed = text.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			// Handle wrapper: { query, results: [{ title, url, ... }] }
			if (typeof parsed === "object" && parsed !== null) {
				const wrapper = parsed as JsonSearchResponse;
				if (Array.isArray(wrapper.results) && wrapper.results.length > 0) {
					return parseJsonResults(wrapper.results);
				}
			}
			// Handle bare array or single result
			const jsonResults = parsed as JsonSearchResult | JsonSearchResult[];
			return parseJsonResults(Array.isArray(jsonResults) ? jsonResults : [jsonResults]);
		} catch {
			// Not valid JSON — fall through to text parsing
		}

	} // End of JSON parse block — fall through to text format

	// Text format: "Title: ...\nURL: ...\nPublished: ...\n\n...\n---"
	const sources: SearchSource[] = [];
	const blocks = text.split(/\n---\n/);
	for (const block of blocks) {
		const lines = block.split("\n");
		let title = "";
		let url = "";
		let publishedDate: string | undefined;
		let inBody = false;
		const bodyLines: string[] = [];

		for (const line of lines) {
			const trimmed_ = line.trim();
			if (trimmed_.startsWith("Title: ")) {
				title = trimmed_.slice(7).trim();
			} else if (trimmed_.startsWith("URL: ")) {
				url = trimmed_.slice(5).trim();
			} else if (trimmed_.startsWith("Published: ")) {
				const val = trimmed_.slice(11).trim();
				if (val) publishedDate = val;
			} else if (trimmed_ === "") {
				if (title && url) inBody = true;
			} else if (inBody) {
				bodyLines.push(trimmed_);
			}
		}

		if (!url) continue;

		if (bodyLines.length > 0) {
			const snippet = bodyLines.join(" ").replace(/\s+/g, " ").trim();
			sources.push({
				title: title || url,
				url,
				snippet: snippet.length > 500 ? snippet.slice(0, 500) + "..." : snippet,
				publishedDate,
			});
			continue;
		}

		sources.push({
			title: title || url,
			url,
			snippet: undefined,
			publishedDate,
		});
	}

	return sources;
}

/** Execute Keenable web search via MCP. */
export async function searchKeenable(params: SearchParamsWithFetch): Promise<SearchResponse> {
	const fetchImpl = params.fetch ?? fetch;
	const publishedAfter = recencyToDate(params.recency);
	const apiKey = await findApiKey(params.authStorage, params.sessionId, params.signal);
	const text = await callKeenableMcpSearch(params.query, publishedAfter, apiKey, params.signal, fetchImpl);
	const allSources = parseKeenableResponse(text);
	const numResults = params.numSearchResults ?? params.limit;
	const sources = numResults ? allSources.slice(0, numResults) : allSources;

	return {
		provider: "keenable",
		sources,
	};
}

/** Resolve Keenable API key from env, process.env, or agent.db. */
async function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	// Try standard env resolver first (checks CATALOG_PROVIDERS, PROVIDER_REGISTRY,
	// and LEGACY_ENV_KEYS mapping). If keenable is not registered there, fall back
	// to direct process.env check.
	const envKey = getEnvApiKey("keenable") ?? (typeof process !== "undefined" ? process.env.KEENABLE_API_KEY : undefined);
	if (envKey) return envKey;
	return authStorage.getApiKey("keenable", sessionId, { signal });
}

/** Search provider for Keenable. */
export class KeenableProvider extends SearchProvider {
	readonly id = "keenable";
	readonly label = "Keenable";

	isAvailable(_authStorage: AuthStorage): boolean {
		// MCP server works without authentication (1,000 req/hr free tier).
		return true;
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchKeenable(params);
	}
}
