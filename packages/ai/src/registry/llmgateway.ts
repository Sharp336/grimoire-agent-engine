import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * LLM Gateway login (API-key paste). DevPass keys are LLM Gateway keys and use
 * the same endpoint. `/v1/models` is public (returns 200 for any key), so it
 * cannot validate credentials — they surface on the first real request instead
 * (same approach as Vercel AI Gateway / Cloudflare AI Gateway).
 */
export const loginLLMGateway = createApiKeyLogin({
	providerLabel: "LLM Gateway",
	authUrl: "https://llmgateway.io/dashboard",
	instructions: "Create or copy your LLM Gateway / DevPass API key from the dashboard",
	promptMessage: "Paste your LLM Gateway API key",
	placeholder: "llmgtwy_...",
	validation: null,
});

export const llmGatewayProvider = {
	id: "llmgateway",
	name: "LLM Gateway",
	login: (cb: OAuthLoginCallbacks) => loginLLMGateway(cb),
} as const satisfies ProviderDefinition;
