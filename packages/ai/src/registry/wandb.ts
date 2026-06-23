import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginWandb = createApiKeyLogin({
	providerLabel: "Weights & Biases",
	authUrl: "https://wandb.ai/settings",
	instructions: "Copy your W&B API key from User Settings",
	promptMessage: "Paste your W&B API key",
	placeholder: "wandb_...",
	validation: {
		kind: "models-endpoint",
		provider: "Weights & Biases",
		modelsUrl: "https://api.inference.wandb.ai/v1/models",
	},
});

export const wandbProvider = {
	id: "wandb",
	name: "Weights & Biases",
	login: (cb: OAuthLoginCallbacks) => loginWandb(cb),
} as const satisfies ProviderDefinition;
