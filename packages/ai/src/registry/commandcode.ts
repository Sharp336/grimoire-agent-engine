/** Command Code login flow (API key paste against the OpenAI-compatible Provider API). */
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginCommandCode = createApiKeyLogin({
	providerLabel: "Command Code",
	authUrl: "https://commandcode.ai/studio/api-keys",
	instructions: "Create an API key in Command Code Studio (Provider plan) and copy it",
	promptMessage: "Paste your Command Code API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "commandcode",
		modelsUrl: "https://api.commandcode.ai/provider/v1/models",
	},
});

export const commandCodeProvider = {
	id: "commandcode",
	name: "Command Code",
	login: (cb: OAuthLoginCallbacks) => loginCommandCode(cb),
} as const satisfies ProviderDefinition;
