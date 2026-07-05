import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginMorphllm = createApiKeyLogin({
	providerLabel: "Morph",
	authUrl: "https://morphllm.com/dashboard/api-keys",
	instructions: "Copy your API key from the Morph dashboard",
	promptMessage: "Paste your Morph API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "morphllm",
		baseUrl: "https://api.morphllm.com/v1",
		model: "morph-qwen35-397b",
	},
});

export const morphllmProvider = {
	id: "morphllm",
	name: "Morph",
	login: (cb: Parameters<typeof loginMorphllm>[0]) => loginMorphllm(cb),
} as const satisfies ProviderDefinition;
