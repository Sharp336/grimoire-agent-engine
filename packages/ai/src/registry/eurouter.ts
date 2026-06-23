import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginEURouter = createApiKeyLogin({
	providerLabel: "EUrouter",
	authUrl: "https://www.eurouter.ai/sign-up",
	instructions: "Create or copy your EUrouter API key",
	promptMessage: "Paste your EUrouter API key",
	placeholder: "eur_...",
	validation: {
		kind: "models-endpoint",
		provider: "EUrouter",
		modelsUrl: "https://api.eurouter.ai/api/v1/models",
	},
});

export const eurouterProvider = {
	id: "eurouter",
	name: "EUrouter",
	login: (cb: OAuthLoginCallbacks) => loginEURouter(cb),
} as const satisfies ProviderDefinition;
