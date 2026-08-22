/**
 * OpenAI Codex Web Search Provider
 *
 * Uses only the official ChatGPT Codex Responses endpoint with openai-codex OAuth.
 */
import { type AuthStorage, type FetchImpl, type Model, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { resolveCodexResponsesUrl } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { $env, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import {
	callHostedResponsesSearch,
	HostedResponsesNoWebSearchError,
	type HostedResponsesResult,
} from "./hosted-responses";

const CODEX_RESPONSES_URL = resolveCodexResponsesUrl(CODEX_BASE_URL);

const FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PREFERENCES = [
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.6-sol",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5-codex",
	"gpt-5",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1-codex",
	"gpt-5-codex-mini",
];
type CodexSearchModel = Model<"openai-codex-responses">;

interface CodexModelCandidate {
	modelId: string;
	catalogModel?: CodexSearchModel;
}

type CodexSearchResult = HostedResponsesResult;

function getBundledCodexModels(): CodexSearchModel[] {
	const models: CodexSearchModel[] = [];
	for (const model of getBundledModels("openai-codex")) {
		if (model.api === "openai-codex-responses") {
			models.push(model as CodexSearchModel);
		}
	}
	return models;
}

function getConfiguredModel(): CodexModelCandidate | undefined {
	const configuredModel = $env.PI_CODEX_WEB_SEARCH_MODEL?.trim();
	if (!configuredModel) return undefined;

	const catalogModel = getBundledCodexModels().find(model => model.id === configuredModel);
	return { modelId: configuredModel, ...(catalogModel ? { catalogModel } : {}) };
}

function getDefaultModelCandidates(): CodexModelCandidate[] {
	const bundledModels = getBundledCodexModels();
	const candidates: CodexModelCandidate[] = [];
	for (const modelId of DEFAULT_MODEL_PREFERENCES) {
		const catalogModel = bundledModels.find(model => model.id === modelId);
		if (catalogModel) candidates.push({ modelId, catalogModel });
	}

	if (candidates.length > 0) {
		return candidates;
	}

	const nonMini = bundledModels.find(model => !model.id.includes("mini") && !model.id.includes("spark"));
	if (nonMini) {
		return [{ modelId: nonMini.id, catalogModel: nonMini }];
	}

	const fallbackModel = bundledModels[0];
	return fallbackModel ? [{ modelId: fallbackModel.id, catalogModel: fallbackModel }] : [{ modelId: FALLBACK_MODEL }];
}

function shouldRetryWithNextDefaultModel(error: unknown): boolean {
	if (error instanceof HostedResponsesNoWebSearchError) return true;
	if (!(error instanceof SearchProviderError)) return false;
	if (error.provider !== "codex" || error.status !== 400) return false;
	return /model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
		error.message,
	);
}

export interface CodexSearchParams {
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Search context size: controls how much web content to include */
	search_context_size?: "low" | "medium" | "high";
}

/** Build HTTP headers for the official ChatGPT Codex Responses endpoint. */
function buildCodexHeaders(accessToken: string, accountId: string): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	applyCodexResidencyHeader(headers, accessToken);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, CODEX_CLIENT_VERSION);
	headers.set("User-Agent", USER_AGENT);
	headers.set("Accept", "text/event-stream");
	headers.set("Content-Type", "application/json");
	return headers;
}

/** Call the official Codex Responses endpoint with shared Hosted Search logic. */
async function callCodexSearch(
	auth: { accessToken: string; accountId: string },
	query: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		systemPrompt: string;
		searchContextSize?: "low" | "medium" | "high";
		model: CodexModelCandidate;
		fetch?: FetchImpl;
	},
): Promise<CodexSearchResult> {
	return callHostedResponsesSearch({
		provider: "codex",
		displayName: "Codex",
		url: CODEX_RESPONSES_URL,
		model: options.model.modelId,
		query,
		instructions: options.systemPrompt,
		searchContextSize: options.searchContextSize,
		headers: buildCodexHeaders(auth.accessToken, auth.accountId),
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		fetch: options.fetch,
	});
}

async function runCodexSearchCandidates(options: {
	auth: { accessToken: string; accountId: string };
	params: SearchParams;
	query: string;
	modelCandidates: CodexModelCandidate[];
	modelWasConfigured: boolean;
}): Promise<CodexSearchResult> {
	let lastError: unknown;
	for (let index = 0; index < options.modelCandidates.length; index += 1) {
		const candidate = options.modelCandidates[index];
		if (!candidate) continue;

		try {
			return await callCodexSearch(options.auth, options.query, {
				signal: options.params.signal,
				timeoutMs: options.params.timeoutMs,
				systemPrompt: options.params.systemPrompt,
				searchContextSize: "high",
				model: candidate,
				fetch: options.params.fetch,
			});
		} catch (error) {
			lastError = error;
			const isLastCandidate = index === options.modelCandidates.length - 1;
			if (options.modelWasConfigured || isLastCandidate || !shouldRetryWithNextDefaultModel(error)) {
				throw error;
			}
		}
	}
	throw lastError ?? new Error("Codex search failed without returning a result");
}

/**
 * Executes a web search using OpenAI Codex's built-in web search tool.
 *
 * Default-model behavior:
 * - If `PI_CODEX_WEB_SEARCH_MODEL` is set, use it exactly once and surface any
 *   upstream error verbatim.
 * - Otherwise prefer ChatGPT-account-safe bundled defaults (GPT-5.6 Luna,
 *   Terra, Sol, GPT-5.5, …) and retry the next candidate only when Codex
 *   returns the known 400 "model is not supported" family. This avoids
 *   selecting `gpt-5-codex-mini` first on ChatGPT accounts, which OpenAI
 *   rejects.
 */
export async function searchCodex(params: SearchParams): Promise<SearchResponse> {
	const configuredModel = getConfiguredModel();
	const modelCandidates = configuredModel ? [configuredModel] : getDefaultModelCandidates();
	const firstCandidate = modelCandidates[0];
	if (!firstCandidate) {
		throw new SearchProviderError("codex", "No Codex web search model is configured.");
	}
	// The ChatGPT-backend Codex endpoint speaks the undocumented codex-rs
	// request shape, so re-emit directive queries with the classic Google-style
	// operators and leave directive-free queries byte-identical.
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;

	const result = await withOAuthAccess(
		params.authStorage,
		"openai-codex",
		access => {
			const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
			if (!accountId) throw new Error("Codex OAuth credential is missing a ChatGPT account id");
			return runCodexSearchCandidates({
				auth: { accessToken: access.accessToken, accountId },
				params,
				query,
				modelCandidates,
				modelWasConfigured: configuredModel !== undefined,
			});
		},
		{
			sessionId: params.sessionId,
			signal: params.signal,
			missingAccessMessage:
				"No Codex OAuth credentials found. Login with 'omp /login openai-codex' to enable Codex web search.",
		},
	);

	let sources = result.sources;
	const numResults = params.numSearchResults ?? params.limit;
	if (numResults && sources.length > numResults) sources = sources.slice(0, numResults);

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		citations: result.citations.length > 0 ? result.citations : undefined,
		usage: result.usage,
		model: result.model,
		requestId: result.requestId,
	};
}

/**
 * Checks whether Codex web search has an openai-codex OAuth credential.
 */
export async function hasCodexSearch(authStorage: AuthStorage): Promise<boolean> {
	return authStorage.hasOAuth("openai-codex");
}

/** Search provider for OpenAI Codex web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI Codex";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
