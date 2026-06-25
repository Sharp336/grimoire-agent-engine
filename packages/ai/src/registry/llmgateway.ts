import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * LLM Gateway login (API-key paste). DevPass keys are LLM Gateway keys and use
 * the same endpoint. `/v1/models` is public (returns 200 for any key), so it
 * cannot validate auth — ping chat completions with a cheap model instead.
 */
export const loginLLMGateway = createApiKeyLogin({
	providerLabel: "LLM Gateway",
	authUrl: "https://llmgateway.io/dashboard",
	instructions: "Create or copy your LLM Gateway / DevPass API key from the dashboard",
	promptMessage: "Paste your LLM Gateway API key",
	placeholder: "llmgtwy_...",
	validation: {
		kind: "chat-completions",
		provider: "LLM Gateway",
		baseUrl: "https://api.llmgateway.io/v1",
		model: "gpt-4o-mini",
	},
});

export const llmGatewayProvider = {
	id: "llmgateway",
	name: "LLM Gateway",
	login: (cb: OAuthLoginCallbacks) => loginLLMGateway(cb),
} as const satisfies ProviderDefinition;
