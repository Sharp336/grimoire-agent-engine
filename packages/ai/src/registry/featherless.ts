import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1";
const FEATHERLESS_MODELS_URL = `${FEATHERLESS_BASE_URL}/models`;

export const loginFeatherless = createApiKeyLogin({
	providerLabel: "Featherless",
	authUrl: "https://featherless.ai/account/api-keys",
	instructions: "Create/copy an API key from the Featherless account API keys page",
	promptMessage: "Paste your Featherless API key",
	placeholder: "rc_...",
	validation: {
		kind: "models-endpoint",
		provider: "Featherless",
		modelsUrl: FEATHERLESS_MODELS_URL,
	},
});

export const featherlessProvider = {
	id: "featherless",
	name: "Featherless",
	login: (cb: OAuthLoginCallbacks) => loginFeatherless(cb),
} as const satisfies ProviderDefinition;
