import { fetchOpenAICompatibleModels } from "../discovery/openai-compatible";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl, ModelSpec } from "../types";

const COMMAND_CODE_PROVIDER_BASE_URL = "https://api.commandcode.ai/provider";
const COMMAND_CODE_DISCOVERY_BASE_URL = `${COMMAND_CODE_PROVIDER_BASE_URL}/v1`;

export interface CommandCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeBasePath(baseUrl: string | undefined): string {
	const value = (baseUrl ?? COMMAND_CODE_PROVIDER_BASE_URL).trim().replace(/\/+$/, "");
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

function baseUrlForApi(api: Api, basePath: string): string {
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

function isAnthropicModelId(id: string): boolean {
	const normalized = id.toLowerCase();
	return normalized.includes("claude") || normalized.includes("anthropic");
}

/**
 * Command Code exposes one model list but two wire protocols:
 * Anthropic models use `/provider/v1/messages`, while every other model uses
 * `/provider/v1/chat/completions`. Sending a model to the wrong endpoint is a
 * hard 400, so routing is resolved per discovered model.
 */
export function resolveCommandCodeApi(modelId: string): Api {
	const reference = resolveModelReference(modelId, getBundledModelReferenceIndex());
	return reference?.api === "anthropic-messages" || isAnthropicModelId(modelId)
		? "anthropic-messages"
		: "openai-completions";
}

function mapCommandCodeModel(defaults: ModelSpec<Api>, basePath: string): ModelSpec<Api> {
	const reference = resolveModelReference(defaults.id, getBundledModelReferenceIndex());
	const api = resolveCommandCodeApi(defaults.id);
	const sameWireReference = reference?.api === api ? reference : undefined;
	return {
		...defaults,
		name: reference?.name ?? defaults.name,
		api,
		provider: "command-code",
		baseUrl: baseUrlForApi(api, basePath),
		reasoning: reference?.reasoning ?? defaults.reasoning,
		input: reference?.input ?? defaults.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: reference?.contextWindow ?? defaults.contextWindow,
		maxTokens: reference?.maxTokens ?? defaults.maxTokens,
		...(sameWireReference?.thinking ? { thinking: sameWireReference.thinking } : {}),
	};
}

export function commandCodeModelManagerOptions(
	config?: CommandCodeModelManagerConfig,
): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const basePath = normalizeBasePath(config?.baseUrl);
	const discoveryBaseUrl = baseUrlForApi("openai-completions", basePath);

	return {
		providerId: "command-code",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "command-code",
					baseUrl: discoveryBaseUrl,
					apiKey,
					mapModel: (_entry, defaults) => mapCommandCodeModel(defaults, basePath),
					fetch: config?.fetch,
				}),
		}),
	};
}

export const COMMAND_CODE_DEFAULT_BASE_URL = COMMAND_CODE_DISCOVERY_BASE_URL;
