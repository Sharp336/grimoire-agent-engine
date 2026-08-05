import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/** Google Gemini login flow (API key paste, validated via the OpenAI-compat models endpoint). */
export const loginGoogle = createApiKeyLogin({
	providerLabel: "Google Gemini",
	authUrl: "https://aistudio.google.com/app/apikey",
	instructions: "Create or copy your API key from Google AI Studio",
	promptMessage: "Paste your Google Gemini API key",
	placeholder: "AIza...",
	validation: {
		kind: "models-endpoint",
		provider: "Google Gemini",
		modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
	},
});

export const googleProvider = {
	id: "google",
	name: "Google Gemini",
	login: (cb: OAuthLoginCallbacks) => loginGoogle(cb),
} as const satisfies ProviderDefinition;
