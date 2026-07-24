import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

/** Login flow for Cline's pay-as-you-go API-credit gateway. */
export const loginClineApi = createApiKeyLogin({
	providerLabel: "Cline API",
	authUrl: "https://app.cline.bot/dashboard/account",
	instructions: "Create an API key in the Cline dashboard (Settings → API Keys)",
	promptMessage: "Paste your Cline API key",
	placeholder: "sk_...",
	validation: {
		kind: "chat-completions",
		provider: "Cline API",
		baseUrl: "https://api.cline.bot/api/v1",
		model: "zai/glm-5.2",
		// ClinePass routes runtime requests through `max_completion_tokens`, and
		// its reasoning models 5xx with "empty response content" when a 1-token
		// budget leaves no room after thinking. Validate with the runtime field
		// and a real budget so a valid key is never rejected during /login.
		maxTokensField: "max_completion_tokens",
		maxTokens: 256,
	},
});

export const clineApiProvider = {
	id: "cline-api",
	name: "Cline API (usage credits)",
	login: loginClineApi,
} as const satisfies ProviderDefinition;
