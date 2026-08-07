import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginUpstage = createApiKeyLogin({
	providerLabel: "Upstage",
	authUrl: "https://console.upstage.ai/api-keys",
	instructions: "Create or copy your API key from the Upstage Console",
	promptMessage: "Paste your Upstage API key",
	placeholder: "up_...",
	validation: {
		kind: "models-endpoint",
		provider: "upstage",
		modelsUrl: "https://api.upstage.ai/v1/models",
	},
});

export const upstageProvider = {
	id: "upstage",
	name: "Upstage",
	login: (cb: OAuthLoginCallbacks) => loginUpstage(cb),
} as const satisfies ProviderDefinition;
