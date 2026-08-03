import { FEATHERLESS_BASE_URL, FEATHERLESS_HEADERS } from "@oh-my-pi/pi-catalog/provider-models";
import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginFeatherless = createApiKeyLogin({
	providerLabel: "Featherless",
	authUrl: "https://featherless.ai/account/api-keys",
	instructions: "Copy your API key from the Featherless dashboard",
	promptMessage: "Paste your Featherless API key",
	placeholder: "API key",
	validation: {
		kind: "chat-completions",
		provider: "featherless",
		baseUrl: FEATHERLESS_BASE_URL,
		model: "zai-org/GLM-5.2",
		headers: FEATHERLESS_HEADERS,
	},
});

export const featherlessProvider = {
	id: "featherless",
	name: "Featherless",
	login: (cb: Parameters<typeof loginFeatherless>[0]) => loginFeatherless(cb),
} as const satisfies ProviderDefinition;
