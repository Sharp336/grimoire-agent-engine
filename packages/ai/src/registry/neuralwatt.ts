import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginNeuralwatt = createApiKeyLogin({
	providerLabel: "Neuralwatt",
	authUrl: "https://api.neuralwatt.com/v1",
	instructions: "Create or copy your Neuralwatt API key",
	promptMessage: "Paste your Neuralwatt API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Neuralwatt",
		modelsUrl: "https://api.neuralwatt.com/v1/models",
	},
});

export const neuralwattProvider = {
	id: "neuralwatt",
	name: "Neuralwatt",
	login: (cb: OAuthLoginCallbacks) => loginNeuralwatt(cb),
} as const satisfies ProviderDefinition;
