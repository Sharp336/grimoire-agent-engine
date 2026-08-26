import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginAnySearch = createApiKeyLogin({
	providerLabel: "AnySearch",
	authUrl: "https://www.anysearch.com/console",
	instructions: "Create or copy your API key from the AnySearch console.",
	promptMessage: "Paste your AnySearch API key",
	placeholder: "API key",
	validation: null,
});

export const anySearchProvider = {
	id: "anysearch",
	name: "AnySearch",
	envKeys: "ANYSEARCH_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginAnySearch(cb),
} as const satisfies ProviderDefinition;
