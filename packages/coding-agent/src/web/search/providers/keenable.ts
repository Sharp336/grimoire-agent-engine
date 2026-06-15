/**
 * Keenable Web Search Provider
 *
 * Uses Keenable's MCP server (works without an API key, 1,000 req/hr free).
 * Set KEENABLE_API_KEY for higher rate limits.
 */

import { type AuthStorage, type FetchImpl } from "@oh-my-pi/pi-ai";
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
}

/** @visible_for_testing */
export function recencyToDate(recency?: "day" | "week" | "month" | "year"): string | undefined {
	const now = Date.now();
	let ms: number;
	switch (recency) {
		case "day": ms = 86_400_000; break;
		case "week": ms = 604_800_000; break;
		case "month": ms = 2_592_000_000; break;
		case "year": ms = 31_536_000_000; break;
		default: return undefined;
	}
	const d = new Date(now - ms);
	return d.toISOString().slice(0, 10);
}

/**
 * Execute a full MCP session (initialize + initialized + tools/call) for a single search.
 */
async function callKeenableMcpSearch(
	query: string,
	publishedAfter: string | undefined,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<string> {
	const timeoutSignal = withHardTimeout(signal);

	async function mcpPost(body: unknown, sessionId?: string): Promise<{ data: KeenableMcpResult; sessionId: string | null }> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (sessionId) {
			headers["Mcp-Session-Id"] = sessionId;
		}
		const resp = await fetchImpl(KEENABLE_MCP_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: timeoutSignal,
		});
		if (!resp.ok) {
			const text = await resp.text();
			throw new SearchProviderError("keenable", `MCP error (${resp.status}): ${text}`, resp.status);
		}
		const data = await resp.json() as KeenableMcpResult;
		return { data, sessionId: resp.headers.get("Mcp-Session-Id") };
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

	// Step 2: initialized notification (fire-and-forget)
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

/**
 * Parse Keenable's MCP text response into SearchSource[].
 *
 * Format per result:
 *   Title: ...
 *   URL: ...
 *   Published: YYYY-MM-DD
 *   Acquired: YYYY-MM-DD
 *
 *   ...description/snippet...
 *   ---
 */
/** @visible_for_testing */
export function parseKeenableResponse(text: string): SearchSource[] {
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
			const trimmed = line.trim();
			if (trimmed.startsWith("Title: ")) {
				title = trimmed.slice(7).trim();
			} else if (trimmed.startsWith("URL: ")) {
				url = trimmed.slice(5).trim();
			} else if (trimmed.startsWith("Published: ")) {
				const val = trimmed.slice(11).trim();
				if (val) publishedDate = val;
			} else if (trimmed === "") {
				if (title && url) inBody = true;
			} else if (inBody) {
				bodyLines.push(trimmed);
			}
		}

		if (!url) continue;

		if (bodyLines.length > 0) {
			const snippet = bodyLines.join(" ").replace(/\s+/g, " ").trim();
			const finalSnippet = snippet.length > 500 ? snippet.slice(0, 500) + "..." : snippet;
			sources.push({
				title: title || url,
				url,
				snippet: finalSnippet,
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
	const text = await callKeenableMcpSearch(params.query, publishedAfter, params.signal, fetchImpl);
	const allSources = parseKeenableResponse(text);
	const numResults = params.numSearchResults ?? params.limit;
	const sources = numResults ? allSources.slice(0, numResults) : allSources;

	return {
		provider: "keenable",
		sources,
	};
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
