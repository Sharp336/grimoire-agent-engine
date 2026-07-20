import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginAtlasCloud = createApiKeyLogin({
	providerLabel: "Atlas Cloud",
	authUrl: "https://www.atlascloud.ai/console/api-keys",
	instructions: "Create or copy your API key from the Atlas Cloud console",
	promptMessage: "Paste your Atlas Cloud API key",
	placeholder: "apikey-...",
	validation: {
		kind: "models-endpoint",
		provider: "Atlas Cloud",
		modelsUrl: "https://api.atlascloud.ai/v1/models",
	},
});

export const atlascloudProvider = {
	id: "atlascloud",
	name: "Atlas Cloud",
	login: (cb: OAuthLoginCallbacks) => loginAtlasCloud(cb),
} as const satisfies ProviderDefinition;
