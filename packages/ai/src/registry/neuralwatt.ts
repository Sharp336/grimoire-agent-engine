import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginNeuralwatt = createApiKeyLogin({
	providerLabel: "Neuralwatt",
	authUrl: "https://portal.neuralwatt.com",
	instructions: "Create or copy your API key from your Neuralwatt dashboard",
	promptMessage: "Paste your Neuralwatt API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "Neuralwatt",
		baseUrl: "https://api.neuralwatt.com/v1",
		model: "glm-5.2",
	},
});

export const neuralwattProvider = {
	id: "neuralwatt",
	name: "Neuralwatt",
	login: (cb: OAuthLoginCallbacks) => loginNeuralwatt(cb),
} as const satisfies ProviderDefinition;
