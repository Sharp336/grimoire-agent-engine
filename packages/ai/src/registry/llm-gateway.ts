import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://devpass.llmgateway.io";

/**
 * Login to LLM Gateway.
 *
 * Opens browser to DevPass dashboard, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginLLMGateway = createApiKeyLogin({
	providerLabel: "LLM Gateway",
	authUrl: AUTH_URL,
	instructions: "Copy your DevPass API key from llmgateway.io",
	promptMessage: "Paste your LLM Gateway API key",
	placeholder: "llmgtwy_...",
	// Skip chat-completions validation: LLM Gateway is self-hostable, so
	// the login flow cannot know which endpoint to validate against. The key
	// is validated implicitly on the first request.
	validation: null,
});

export const llmGatewayProvider = {
	id: "llmgateway",
	name: "LLM Gateway",
	login: (cb: OAuthLoginCallbacks) => loginLLMGateway(cb),
} as const satisfies ProviderDefinition;
