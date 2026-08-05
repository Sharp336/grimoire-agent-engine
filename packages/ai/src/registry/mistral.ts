import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/** Mistral login flow (API key paste, validated via the models endpoint). */
export const loginMistral = createApiKeyLogin({
	providerLabel: "Mistral",
	authUrl: "https://console.mistral.ai/api-keys/",
	instructions: "Create or copy your API key from the Mistral console",
	promptMessage: "Paste your Mistral API key",
	placeholder: "gsk_...",
	validation: {
		kind: "models-endpoint",
		provider: "Mistral",
		modelsUrl: "https://api.mistral.ai/v1/models",
	},
});

export const mistralProvider = {
	id: "mistral",
	name: "Mistral",
	login: (cb: OAuthLoginCallbacks) => loginMistral(cb),
} as const satisfies ProviderDefinition;
