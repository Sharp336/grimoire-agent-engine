/** Google Gemini Web Search provider (Gemini CLI OAuth or Developer API key). */
import { type AuthStorage, type FetchImpl, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getGeminiCliHeaders } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { fetchWithRetry } from "@oh-my-pi/pi-utils";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery, type StructuredQuery } from "../query";
import type { SearchResponse } from "../types";
import { SearchProviderError } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	type GeminiGroundedResponse,
	type GroundedSearchResult,
	parseGeminiGroundedResponse,
} from "./gemini-grounding";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const DEVELOPER_API_PROVIDER = "google";
const DEVELOPER_API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const GEMINI_OAUTH_PROVIDER = "google-gemini-cli";

function resolveGeminiSearchModel(configuredModel: string | undefined): string {
	const envModel = Bun.env.GEMINI_SEARCH_MODEL?.trim();
	if (envModel) return envModel;
	return configuredModel?.trim() || DEFAULT_MODEL;
}

interface GeminiToolParams {
	google_search?: Record<string, unknown>;
	code_execution?: Record<string, unknown>;
	url_context?: Record<string, unknown>;
}

export interface GeminiSearchParams extends GeminiToolParams {
	query: string;
	parsedQuery?: StructuredQuery;
	system_prompt?: string;
	num_results?: number;
	max_output_tokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
	geminiModel?: string;
}

export function buildGeminiRequestTools(params: GeminiToolParams): Array<Record<string, Record<string, unknown>>> {
	const tools: Array<Record<string, Record<string, unknown>>> = [{ googleSearch: params.google_search ?? {} }];
	if (params.code_execution !== undefined) tools.push({ codeExecution: params.code_execution });
	if (params.url_context !== undefined) tools.push({ urlContext: params.url_context });
	return tools;
}

interface GeminiAuth {
	accessToken: string;
	projectId: string;
}

interface GeminiAuthSeed {
	access: OAuthAccess;
	projectId: string;
}

type GeminiSearchResult = GroundedSearchResult;

/** Resolves Gemini CLI OAuth only; Antigravity credentials belong to its own provider. */
export async function findGeminiAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<GeminiAuthSeed | null> {
	const access = await authStorage.getOAuthAccess(GEMINI_OAUTH_PROVIDER, sessionId, { signal });
	if (!access?.accessToken || !access.projectId) return null;
	return { access, projectId: access.projectId };
}

function mergeResult(target: GeminiSearchResult, chunk: GeminiGroundedResponse, fallbackModel: string): void {
	const parsed = parseGeminiGroundedResponse(chunk, fallbackModel);
	target.answer += parsed.answer;
	for (const source of parsed.sources) {
		if (!target.sources.some(existing => existing.url === source.url)) target.sources.push(source);
	}
	target.citations.push(...parsed.citations);
	for (const query of parsed.searchQueries) {
		if (!target.searchQueries.includes(query)) target.searchQueries.push(query);
	}
	target.model = parsed.model;
	target.finishReason = parsed.finishReason ?? target.finishReason;
	target.usage = parsed.usage ?? target.usage;
}

async function parseGeminiSearchStream(
	body: ReadableStream<Uint8Array>,
	fallbackModel: string,
): Promise<GeminiSearchResult> {
	const result: GeminiSearchResult = {
		answer: "",
		sources: [],
		citations: [],
		searchQueries: [],
		model: fallbackModel,
	};
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				try {
					const raw = JSON.parse(line.slice(5).trim()) as {
						response?: GeminiGroundedResponse;
					} & GeminiGroundedResponse;
					mergeResult(result, raw.response ?? raw, fallbackModel);
				} catch {
					// Ignore malformed SSE keep-alives; the final provider response remains authoritative.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	return result;
}

async function callGeminiSearch(
	auth: GeminiAuth,
	model: string,
	query: string,
	systemPrompt: string | undefined,
	maxOutputTokens: number | undefined,
	temperature: number | undefined,
	toolParams: GeminiToolParams,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): Promise<GeminiSearchResult> {
	const normalizedSystemPrompt = systemPrompt?.toWellFormed();
	const request: Record<string, unknown> = {
		contents: [{ role: "user", parts: [{ text: query }] }],
		tools: buildGeminiRequestTools(toolParams),
		...(normalizedSystemPrompt ? { systemInstruction: { parts: [{ text: normalizedSystemPrompt }] } } : {}),
	};
	if (maxOutputTokens !== undefined || temperature !== undefined) {
		request.generationConfig = {
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(temperature !== undefined ? { temperature } : {}),
		};
	}
	const response = await fetchWithRetry(() => `${DEFAULT_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.accessToken}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...getGeminiCliHeaders(),
		},
		body: JSON.stringify({
			project: auth.projectId,
			model,
			request,
			userAgent: "pi-coding-agent",
			requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		}),
		signal: withHardTimeout(signal),
		fetch: fetchImpl,
		maxAttempts: MAX_RETRIES + 1,
		defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
		maxDelayMs: RATE_LIMIT_BUDGET_MS,
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw (
			classifyProviderHttpError("gemini", response.status, errorText) ??
			new SearchProviderError(
				"gemini",
				`Gemini Cloud Code API error (${response.status}): ${errorText}`,
				response.status,
			)
		);
	}
	if (!response.body) throw new SearchProviderError("gemini", "Gemini API returned no response body", 500);
	return parseGeminiSearchStream(response.body, model);
}

async function callGeminiDeveloperSearch(
	apiKey: string,
	model: string,
	query: string,
	systemPrompt: string | undefined,
	maxOutputTokens: number | undefined,
	temperature: number | undefined,
	toolParams: GeminiToolParams,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): Promise<GeminiSearchResult> {
	const normalizedSystemPrompt = systemPrompt?.toWellFormed();
	const request: Record<string, unknown> = {
		contents: [{ role: "user", parts: [{ text: query }] }],
		tools: buildGeminiRequestTools(toolParams),
		...(normalizedSystemPrompt ? { systemInstruction: { parts: [{ text: normalizedSystemPrompt }] } } : {}),
	};
	if (maxOutputTokens !== undefined || temperature !== undefined) {
		request.generationConfig = {
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(temperature !== undefined ? { temperature } : {}),
		};
	}
	const response = await fetchWithRetry(
		() => `${DEVELOPER_API_ENDPOINT}/models/${model}:streamGenerateContent?alt=sse`,
		{
			method: "POST",
			headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify(request),
			signal: withHardTimeout(signal),
			fetch: fetchImpl,
			maxAttempts: MAX_RETRIES + 1,
			defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
			maxDelayMs: RATE_LIMIT_BUDGET_MS,
		},
	);
	if (!response.ok) {
		const errorText = await response.text();
		throw (
			classifyProviderHttpError("gemini", response.status, errorText) ??
			new SearchProviderError(
				"gemini",
				`Gemini Developer API error (${response.status}): ${errorText}`,
				response.status,
			)
		);
	}
	if (!response.body) throw new SearchProviderError("gemini", "Gemini API returned no response body", 500);
	return parseGeminiSearchStream(response.body, model);
}

export async function searchGemini(params: GeminiSearchParams): Promise<SearchResponse> {
	const model = resolveGeminiSearchModel(params.geminiModel);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;
	const seed = await findGeminiAuth(params.authStorage, params.sessionId, params.signal);
	const result = seed
		? await withOAuthAccess(
				params.authStorage,
				GEMINI_OAUTH_PROVIDER,
				access =>
					callGeminiSearch(
						{ accessToken: access.accessToken, projectId: access.projectId ?? seed.projectId },
						model,
						query,
						params.system_prompt,
						params.max_output_tokens,
						params.temperature,
						params,
						params.fetch,
						params.signal,
					),
				{ sessionId: params.sessionId, signal: params.signal, seed: seed.access },
			)
		: await (async () => {
				const apiKey = await params.authStorage.getApiKey(DEVELOPER_API_PROVIDER, params.sessionId, {
					signal: params.signal,
				});
				if (!apiKey)
					throw new Error(
						"No Gemini credentials found. Set GEMINI_API_KEY, configure an API key for provider \"google\", or login with 'omp /login google-gemini-cli' to enable Gemini web search.",
					);
				return callGeminiDeveloperSearch(
					apiKey,
					model,
					query,
					params.system_prompt,
					params.max_output_tokens,
					params.temperature,
					params,
					params.fetch,
					params.signal,
				);
			})();
	return {
		provider: "gemini",
		answer: result.answer || undefined,
		sources: params.num_results ? result.sources.slice(0, params.num_results) : result.sources,
		citations: result.citations.length ? result.citations : undefined,
		searchQueries: result.searchQueries.length ? result.searchQueries : undefined,
		usage: result.usage,
		model: result.model,
	};
}

export class GeminiProvider extends SearchProvider {
	readonly id = "gemini";
	readonly label = "Gemini";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasOAuth(GEMINI_OAUTH_PROVIDER) || authStorage.hasAuth(DEVELOPER_API_PROVIDER);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGemini({
			query: params.query,
			parsedQuery: params.parsedQuery,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			google_search: params.googleSearch,
			code_execution: params.codeExecution,
			url_context: params.urlContext,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
			geminiModel: params.geminiModel,
		});
	}
}
