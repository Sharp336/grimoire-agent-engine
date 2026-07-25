import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://llmgateway.io/dashboard";
const API_BASE_URL = "https://api.llmgateway.io/v1";
// Cheap, always-provisioned model; the gateway's /v1/models endpoint is public,
// so key validation must go through chat completions instead.
const VALIDATION_MODEL = "gpt-4o-mini";

export const loginLlmGateway = createApiKeyLogin({
	providerLabel: "LLM Gateway",
	authUrl: AUTH_URL,
	instructions: "Create or copy an API key from the LLM Gateway dashboard",
	promptMessage: "Paste your LLM Gateway API key",
	placeholder: "llmgtwy_...",
	validation: {
		kind: "chat-completions",
		provider: "LLM Gateway",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const llmgatewayProvider = {
	id: "llmgateway",
	name: "LLM Gateway",
	login: (cb: OAuthLoginCallbacks) => loginLlmGateway(cb),
} as const satisfies ProviderDefinition;
