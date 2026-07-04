import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginLongcat = createApiKeyLogin({
	providerLabel: "LongCat",
	authUrl: "https://longcat.chat/platform/api_keys",
	instructions: "Copy your API key from the LongCat platform console",
	promptMessage: "Paste your LongCat API key",
	placeholder: "ak_...",
	validation: {
		kind: "models-endpoint",
		provider: "longcat",
		modelsUrl: "https://api.longcat.chat/openai/v1/models",
	},
});

export const longcatProvider = {
	id: "longcat",
	name: "LongCat",
	login: (cb: OAuthLoginCallbacks) => loginLongcat(cb),
} as const satisfies ProviderDefinition;
