import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/** OpenAI login flow (API key paste, validated via the models endpoint). */
export const loginOpenAI = createApiKeyLogin({
	providerLabel: "OpenAI",
	authUrl: "https://platform.openai.com/api-keys",
	instructions: "Create or copy your API key from the OpenAI platform dashboard",
	promptMessage: "Paste your OpenAI API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "OpenAI",
		modelsUrl: "https://api.openai.com/v1/models",
	},
});

export const openaiProvider = {
	id: "openai",
	name: "OpenAI",
	login: (cb: OAuthLoginCallbacks) => loginOpenAI(cb),
} as const satisfies ProviderDefinition;
