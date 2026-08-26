import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

const FREEPI_BASE_URL = "https://sponsored-api-pilot-production.up.railway.app/api/v1";

export const loginFreePI = createApiKeyLogin({
	providerLabel: "FreePI",
	authUrl: "https://freepi.ai/account",
	instructions:
		"Review the closed-alpha disclosure and create an API key. FreePI states that raw traces may be retained indefinitely, so do not send secrets or private code.",
	promptMessage: "Paste your FreePI API key",
	placeholder: "ak_...",
	validation: {
		// FreePI's model listing is public, so validate credentials against the
		// authenticated inference endpoint instead.
		kind: "chat-completions",
		provider: "FreePI",
		baseUrl: FREEPI_BASE_URL,
		model: "deepseek/deepseek-v4-flash",
	},
});

export const freepiProvider = {
	id: "freepi",
	name: "FreePI",
	login: (cb: Parameters<typeof loginFreePI>[0]) => loginFreePI(cb),
} as const satisfies ProviderDefinition;
