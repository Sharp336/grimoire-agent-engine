import { type AuthStorage, withAuth } from "@oh-my-pi/pi-ai";
import { settings } from "../../../config/settings";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { callHostedResponsesSearch, resolveHostedResponsesUrl } from "./hosted-responses";

function configuredOpenAIProvider(): string | undefined {
	try {
		const provider = settings.get("providers.webSearchOpenAIProvider");
		if (typeof provider !== "string") return undefined;
		const normalized = provider.trim();
		return normalized.length > 0 ? normalized : undefined;
	} catch {
		return undefined;
	}
}

/** Check auto-chain availability for the configured OpenAI-compatible target. */
export function hasOpenAISearch(authStorage: AuthStorage): boolean {
	const provider = configuredOpenAIProvider();
	if (!provider) return false;
	if (typeof authStorage.hasResolvableAuth === "function") return authStorage.hasResolvableAuth(provider);
	return authStorage.hasAuth(provider);
}

function requireOpenAISelection(params: SearchParams): { provider: string; modelId: string } {
	const provider = params.openaiProvider?.trim();
	const modelId = params.openaiModel?.trim();
	if (!provider || !modelId) {
		throw new SearchProviderError(
			"openai",
			"OpenAI API web search requires both providers.webSearchOpenAIProvider and providers.webSearchOpenAIModel",
		);
	}
	return { provider, modelId };
}

/** Execute Hosted web search through a selected `openai-responses` model. */
export async function searchOpenAI(params: SearchParams): Promise<SearchResponse> {
	const selection = requireOpenAISelection(params);
	const registry = params.modelRegistry;
	if (!registry) {
		throw new SearchProviderError("openai", "OpenAI API web search requires a model registry");
	}

	const model = registry.find(selection.provider, selection.modelId);
	if (!model) {
		throw new SearchProviderError(
			"openai",
			`OpenAI API web search model not found: ${selection.provider}/${selection.modelId}`,
		);
	}
	if (model.api !== "openai-responses") {
		throw new SearchProviderError(
			"openai",
			`OpenAI API web search requires api: openai-responses for ${selection.provider}/${selection.modelId}`,
		);
	}
	if (!model.baseUrl.trim()) {
		throw new SearchProviderError("openai", `OpenAI API web search model has no base URL: ${selection.modelId}`);
	}

	const headers = new Headers({
		...(registry.getProviderHeaders(selection.provider) ?? {}),
		...(model.headers ?? {}),
	});
	headers.delete("chatgpt-account-id");
	headers.set("Accept", "text/event-stream");
	headers.set("Content-Type", "application/json");

	const apiKey = params.authStorage.resolver(selection.provider, {
		sessionId: params.sessionId,
		baseUrl: model.baseUrl,
		modelId: model.id,
	});
	const result = await withAuth(
		apiKey,
		key => {
			const requestHeaders = new Headers(headers);
			requestHeaders.set("Authorization", `Bearer ${key}`);
			return callHostedResponsesSearch({
				provider: "openai",
				displayName: "OpenAI API",
				url: resolveHostedResponsesUrl(model.baseUrl),
				model: model.requestModelId ?? model.id,
				query: params.query,
				instructions: params.systemPrompt,
				headers: requestHeaders,
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch,
			});
		},
		{
			signal: params.signal,
			missingKeyMessage: `API key not found for OpenAI web search provider "${selection.provider}"`,
		},
	);
	const resultCap = params.numSearchResults ?? params.limit;
	const sources = resultCap ? result.sources.slice(0, resultCap) : result.sources;
	const citations = resultCap ? result.citations.slice(0, resultCap) : result.citations;
	return {
		provider: "openai",
		answer: result.answer || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		usage: result.usage,
		model: result.model,
		requestId: result.requestId,
	};
}

/** Search provider for standard OpenAI-compatible Hosted Responses APIs. */
export class OpenAIProvider extends SearchProvider {
	readonly id = "openai";
	readonly label = "OpenAI API";

	isAvailable(authStorage: AuthStorage): boolean {
		return hasOpenAISearch(authStorage);
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchOpenAI(params);
	}
}
