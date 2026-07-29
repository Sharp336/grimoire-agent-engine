import { type AuthStorage, type FetchImpl, postH2Primary, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { ANTIGRAVITY_SYSTEM_INSTRUCTION, getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import antigravitySearchPrompt from "../../../prompts/web-search-antigravity.md" with { type: "text" };
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery, type StructuredQuery } from "../query";
import type { SearchResponse } from "../types";
import { SearchProviderError } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { type GeminiGroundedResponse, parseGeminiGroundedResponse } from "./gemini-grounding";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ANTIGRAVITY_OAUTH_PROVIDER = "google-antigravity";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_MODEL = "gemini-3.6-flash-low";

export interface AntigravitySearchParams {
	query: string;
	parsedQuery?: StructuredQuery;
	systemPrompt?: string;
	numResults?: number;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
	antigravityModel?: string;
	maxOutputTokens?: number;
	temperature?: number;
}

function resolveAntigravitySearchModel(configuredModel: string | undefined): string {
	const envModel = Bun.env.ANTIGRAVITY_SEARCH_MODEL?.trim();
	if (envModel) return envModel;
	return configuredModel?.trim() || DEFAULT_MODEL;
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
		return error.message;
	return undefined;
}

async function responseJson(response: Response): Promise<GeminiGroundedResponse & { error?: unknown }> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	let text = new TextDecoder().decode(bytes);
	if (response.headers.get("content-encoding")?.toLowerCase().includes("gzip")) {
		try {
			text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
		} catch {
			// Fetch implementations may already decode a gzip body while retaining the header.
		}
	}
	try {
		return JSON.parse(text) as GeminiGroundedResponse & { error?: unknown };
	} catch {
		throw new SearchProviderError("antigravity", "Antigravity search returned invalid JSON.", 502);
	}
}

async function callAntigravitySearch(
	accessToken: string,
	projectId: string,
	model: string,
	query: string,
	systemPrompt: string | undefined,
	maxOutputTokens: number | undefined,
	temperature: number | undefined,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): Promise<SearchResponse> {
	const instruction = [ANTIGRAVITY_SYSTEM_INSTRUCTION, antigravitySearchPrompt.trim(), systemPrompt?.toWellFormed()]
		.filter(Boolean)
		.join("\n");
	const request = {
		systemInstruction: { role: "user", parts: [{ text: instruction }] },
		contents: [{ role: "user", parts: [{ text: query }] }],
		generationConfig: {
			candidateCount: 1,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(temperature !== undefined ? { temperature } : {}),
		},
		tools: [{ googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 5 } } } }],
	};
	const url = `${ANTIGRAVITY_DAILY_ENDPOINT}/v1internal:generateContent`;
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": getAntigravityUserAgent(),
		"Content-Type": "application/json",
		"Accept-Encoding": "gzip",
	};
	const body = new TextEncoder().encode(
		JSON.stringify({ model, project: projectId, request, requestType: "agent", userAgent: "antigravity" }),
	);
	const transport = await postH2Primary({
		url,
		provider: "google-antigravity",
		headers,
		body,
		signal: withHardTimeout(signal),
		fetchOverride: fetchImpl,
	});
	const response = new Response(transport.body, { status: transport.status, headers: transport.headers });
	if (!response.ok) {
		const body = await response.text();
		throw (
			classifyProviderHttpError("antigravity", response.status, body) ??
			new SearchProviderError(
				"antigravity",
				`Antigravity search API error (${response.status}): ${body}`,
				response.status,
			)
		);
	}

	const payload = await responseJson(response);
	const providerError = errorMessage(payload.error);
	if (providerError) throw new SearchProviderError("antigravity", `Antigravity search error: ${providerError}`, 502);
	const result = parseGeminiGroundedResponse(payload, model);
	if (!payload.candidates?.length)
		throw new SearchProviderError("antigravity", "Antigravity search returned an empty response.", 502);
	if (result.finishReason?.includes("MAX_TOKENS")) {
		throw new SearchProviderError(
			"antigravity",
			`Antigravity search response overflowed (${result.finishReason}).`,
			413,
		);
	}
	if (!result.sources.length)
		throw new SearchProviderError("antigravity", "Antigravity search returned no Google Search grounding.", 502);
	return {
		provider: "antigravity",
		answer: result.answer || undefined,
		sources: result.sources,
		citations: result.citations.length ? result.citations : undefined,
		searchQueries: result.searchQueries.length ? result.searchQueries : undefined,
		usage: result.usage,
		model: result.model,
	};
}

export async function searchAntigravity(params: AntigravitySearchParams): Promise<SearchResponse> {
	const model = resolveAntigravitySearchModel(params.antigravityModel);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;
	const seed = await params.authStorage.getOAuthAccess(ANTIGRAVITY_OAUTH_PROVIDER, params.sessionId, {
		signal: params.signal,
	});
	if (!seed?.accessToken || !seed.projectId) {
		throw new SearchProviderError(
			"antigravity",
			"Antigravity web search requires google-antigravity OAuth. Run 'omp /login google-antigravity'.",
		);
	}
	const projectId = seed.projectId;
	const response = await withOAuthAccess(
		params.authStorage,
		ANTIGRAVITY_OAUTH_PROVIDER,
		access =>
			callAntigravitySearch(
				access.accessToken,
				access.projectId ?? projectId,
				model,
				query,
				params.systemPrompt,
				params.maxOutputTokens,
				params.temperature,
				params.fetch,
				params.signal,
			),
		{ sessionId: params.sessionId, signal: params.signal, seed },
	);
	return params.numResults ? { ...response, sources: response.sources.slice(0, params.numResults) } : response;
}

export class AntigravityProvider extends SearchProvider {
	readonly id = "antigravity";
	readonly label = "Antigravity";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasOAuth(ANTIGRAVITY_OAUTH_PROVIDER);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAntigravity({
			query: params.query,
			parsedQuery: params.parsedQuery,
			systemPrompt: params.systemPrompt,
			numResults: params.numSearchResults ?? params.limit,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
			antigravityModel: params.antigravityModel,
			maxOutputTokens: params.maxOutputTokens,
			temperature: params.temperature,
		});
	}
}
