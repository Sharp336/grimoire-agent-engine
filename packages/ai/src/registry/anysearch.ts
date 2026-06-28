import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginAnySearch = createApiKeyLogin({
	providerLabel: "AnySearch",
	authUrl: "https://anysearch.com/console/api-keys",
	instructions:
		"Create or copy your AnySearch API key from the AnySearch console. A key is optional for anonymous search, but recommended for higher rate limits.",
	promptMessage: "Paste your AnySearch API key",
	placeholder: "your-api-key",
	validation: null,
});

export const anysearchProvider = {
	id: "anysearch",
	name: "AnySearch",
	envKeys: "ANYSEARCH_API_KEY",
	login: loginAnySearch,
} as const satisfies ProviderDefinition;
