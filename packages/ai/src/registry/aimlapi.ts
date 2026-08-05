import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/** AIML API login flow (API key paste, validated via the models endpoint). */
export const loginAimlApi = createApiKeyLogin({
	providerLabel: "AIML API",
	authUrl: "https://aimlapi.com/app/keys",
	instructions: "Create or copy your API key from the AIML API dashboard",
	promptMessage: "Paste your AIML API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "AIML API",
		modelsUrl: "https://api.aimlapi.com/v1/models",
	},
});

export const aimlApiProvider = {
	id: "aimlapi",
	name: "AIML API",
	login: (cb: OAuthLoginCallbacks) => loginAimlApi(cb),
} as const satisfies ProviderDefinition;
