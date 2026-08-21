import { FEATHERLESS_BASE_URL, FEATHERLESS_HEADERS } from "@oh-my-pi/pi-catalog/provider-models";
import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

/**
 * Featherless API-key login.
 *
 * Validation lists models rather than probing a chat completion: Featherless
 * gates model access per plan, so pinning a specific model would reject a valid
 * key whose plan simply excludes it.
 */
export const loginFeatherless = createApiKeyLogin({
	providerLabel: "Featherless",
	authUrl: "https://featherless.ai/account/api-keys",
	instructions: "Copy your API key from the Featherless dashboard",
	promptMessage: "Paste your Featherless API key",
	placeholder: "API key",
	validation: {
		kind: "models-endpoint",
		provider: "Featherless",
		// One record is enough to authenticate; the catalog has tens of thousands.
		modelsUrl: `${FEATHERLESS_BASE_URL}/models?per_page=1`,
		headers: FEATHERLESS_HEADERS,
	},
});

/** Featherless provider definition: API-key paste login, no OAuth. */
export const featherlessProvider = {
	id: "featherless",
	name: "Featherless",
	login: loginFeatherless,
} as const satisfies ProviderDefinition;
