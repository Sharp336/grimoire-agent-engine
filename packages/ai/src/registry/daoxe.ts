import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginDaoXE = createApiKeyLogin({
	providerLabel: "DaoXE",
	authUrl: "https://daoxe.com/dashboard",
	instructions: "Create or copy your API key from the DaoXE dashboard",
	promptMessage: "Paste your DaoXE API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "DaoXE",
		modelsUrl: "https://daoxe.com/v1/models",
	},
});

export const daoxeProvider = {
	id: "daoxe",
	name: "DaoXE",
	login: (cb: OAuthLoginCallbacks) => loginDaoXE(cb),
} as const satisfies ProviderDefinition;
