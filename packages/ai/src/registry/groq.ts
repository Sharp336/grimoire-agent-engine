import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/** Groq login flow (API key paste, validated via the models endpoint). */
export const loginGroq = createApiKeyLogin({
	providerLabel: "Groq",
	authUrl: "https://console.groq.com/keys",
	instructions: "Create or copy your API key from the Groq console",
	promptMessage: "Paste your Groq API key",
	placeholder: "gsk_...",
	validation: {
		kind: "models-endpoint",
		provider: "Groq",
		modelsUrl: "https://api.groq.com/openai/v1/models",
	},
});

export const groqProvider = {
	id: "groq",
	name: "Groq",
	login: (cb: OAuthLoginCallbacks) => loginGroq(cb),
} as const satisfies ProviderDefinition;
