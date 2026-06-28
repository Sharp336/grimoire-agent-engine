import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { parseSSE } from "../../../mcp/json-rpc";
import { asRecord, asString } from "../../../web/scrapers/utils";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ANYSEARCH_MCP_URL = "https://api.anysearch.com/mcp";
const ANYSEARCH_TOOL_NAME = "search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;

export interface AnySearchSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	authStorage: AuthStorage;
	sessionId?: string;
}

interface JsonRpcErrorShape {
	code?: number;
	message?: string;
	data?: unknown;
}

interface JsonRpcPayload {
	result?: unknown;
	error?: JsonRpcErrorShape;
}

function extractContentText(result: unknown): string {
	const candidates: unknown[] = [result];
	const root = asRecord(result);
	if (root?.structuredContent !== undefined) candidates.push(root.structuredContent);
	if (root?.data !== undefined) candidates.push(root.data);
	if (root?.result !== undefined) candidates.push(root.result);

	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			const trimmed = candidate.trim();
			if (trimmed) return trimmed;
		}

		const obj = asRecord(candidate);
		const content = Array.isArray(obj?.content) ? obj.content : [];
		const text = content
			.map(item => asString(asRecord(item)?.text))
			.filter((value): value is string => value != null)
			.join("\n\n")
			.trim();
		if (text) return text;
	}

	return "";
}

function cleanSnippet(section: string): string | undefined {
	const snippet = section
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !/^[*-]\s+\*\*URL\*\*:/i.test(line) && !/^###\s+/.test(line))
		.map(line => line.replace(/^[*-]\s+/, ""))
		.map(line => line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1"))
		.join(" ")
		.trim();
	return snippet || undefined;
}

/**
 * Parses the Markdown response returned by the AnySearch MCP search tool.
 * The AnySearch server response has the following layout convention:
 *
 * ## Search Results (N results, Time)
 * [Optional preamble/answer text here]
 *
 * ### 1. Document Title
 * - **URL**: https://example.com/url
 * - Snippet text line 1
 * - Snippet text line 2
 *
 * ### 2. Next Document Title
 * ...
 */
export function parseAnySearchMarkdown(markdown: string): { answer?: string; sources: SearchSource[] } {
	const normalized = markdown.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return { sources: [] };

	const firstSection = normalized.search(/(?:^|\n)###\s+/);
	const preamble = firstSection >= 0 ? normalized.slice(0, firstSection).trim() : normalized;
	const answer = preamble.replace(/^##\s*Search Results[^\n]*$/m, "").trim() || undefined;

	const sources: SearchSource[] = [];
	const sectionRegex = /(?:^|\n)###\s+([^\n]+)\n([\s\S]*?)(?=\n###\s+|\s*$)/g;
	for (const match of normalized.matchAll(sectionRegex)) {
		const rawTitle = match[1];
		const title = rawTitle.replace(/^\d+\.\s*/, "").trim() || undefined;
		const body = match[2].trim();
		const url =
			body.match(/(?:^|\n)[*-]\s+\*\*URL\*\*:\s*(https?:\/\/\S+)/i)?.[1] ??
			body.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/)?.[1] ??
			body.match(/https?:\/\/\S+/)?.[0];
		if (!url) continue;
		sources.push({
			title: title || url,
			url,
			snippet: cleanSnippet(body),
		});
	}

	if (sources.length > 0) return { answer, sources };
	if (/no results?/i.test(normalized)) return { answer, sources: [] };

	return {
		answer: normalized,
		sources: [],
	};
}

async function callAnySearchSearch(apiKey: string | undefined, params: AnySearchSearchParams): Promise<string> {
	const response = await (params.fetch ?? fetch)(ANYSEARCH_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: crypto.randomUUID(),
			method: "tools/call",
			params: {
				name: ANYSEARCH_TOOL_NAME,
				arguments: {
					query: params.query,
					max_results: params.num_results,
				},
			},
		}),
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("anysearch", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"anysearch",
			`AnySearch API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const payload = parseSSE(await response.text()) as JsonRpcPayload | null;
	if (!payload) {
		throw new SearchProviderError("anysearch", "Failed to parse AnySearch MCP response", 500);
	}
	if (payload.error) {
		const rawCode = typeof payload.error.code === "number" ? payload.error.code : undefined;
		const status = rawCode && rawCode > 0 ? rawCode : 400;
		throw new SearchProviderError(
			"anysearch",
			`AnySearch MCP error${rawCode ? ` (${rawCode})` : ""}: ${payload.error.message ?? "Unknown error"}`,
			status,
		);
	}

	const result = asRecord(payload.result);
	if (result?.isError === true) {
		const errorText = Array.isArray(result.content)
			? result.content
					.map(item => asString(asRecord(item)?.text))
					.filter((value): value is string => value != null)
					.join("\n")
					.trim()
			: "";
		throw new SearchProviderError("anysearch", errorText || "AnySearch MCP tool call failed", 400);
	}

	const markdown = extractContentText(payload.result);
	if (!markdown) {
		throw new SearchProviderError("anysearch", "AnySearch returned no text content", 502);
	}
	return markdown;
}

export async function searchAnySearch(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const request: AnySearchSearchParams = {
		query: params.query,
		num_results: numResults,
		signal: params.signal,
		fetch: params.fetch,
		authStorage: params.authStorage,
		sessionId: params.sessionId,
	};

	const envKey = getEnvApiKey("anysearch");
	const keyOrResolver: ApiKey | undefined = params.authStorage.hasAuth("anysearch")
		? params.authStorage.resolver("anysearch", { sessionId: params.sessionId })
		: envKey;

	const markdown = keyOrResolver
		? await withAuth(keyOrResolver, key => callAnySearchSearch(key, request), { signal: params.signal })
		: await callAnySearchSearch(undefined, request);

	const parsed = parseAnySearchMarkdown(markdown);

	return {
		provider: "anysearch",
		answer: parsed.answer,
		sources: parsed.sources.slice(0, numResults),
		authMode: keyOrResolver ? "api_key" : "anonymous",
	};
}

export class AnySearchProvider extends SearchProvider {
	readonly id = "anysearch";
	readonly label = "AnySearch";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("anysearch") || !!getEnvApiKey("anysearch");
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnySearch(params);
	}
}
