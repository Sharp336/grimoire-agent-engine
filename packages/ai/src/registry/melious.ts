import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginMelious = createApiKeyLogin({
	providerLabel: "Melious",
	authUrl: "https://melious.ai",
	instructions: "Create or copy your Melious API key",
	promptMessage: "Paste your Melious API key",
	placeholder: "sk-mel-...",
	validation: {
		kind: "models-endpoint",
		provider: "Melious",
		modelsUrl: "https://api.melious.ai/v1/models",
	},
});

export const meliousProvider = {
	id: "melious",
	name: "Melious",
	login: (cb: OAuthLoginCallbacks) => loginMelious(cb),
} as const satisfies ProviderDefinition;
