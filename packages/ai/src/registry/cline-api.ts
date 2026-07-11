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
		maxTokensField: "max_completion_tokens",
		maxTokens: 256,
	},
});

export const clineApiProvider = {
	id: "cline-api",
	name: "Cline API (usage credits)",
	login: loginClineApi,
} as const satisfies ProviderDefinition;
