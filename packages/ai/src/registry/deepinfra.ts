import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginDeepInfra = createApiKeyLogin({
	providerLabel: "DeepInfra",
	authUrl: "https://deepinfra.com/dash/api_keys",
	instructions: "Create or copy your DeepInfra API key",
	promptMessage: "Paste your DeepInfra API key",
	placeholder: "your-token",
	validation: {
		kind: "chat-completions",
		provider: "DeepInfra",
		baseUrl: "https://api.deepinfra.com/v1/openai",
		model: "deepseek-ai/DeepSeek-V3",
	},
});

export const deepinfraProvider = {
	id: "deepinfra",
	name: "DeepInfra",
	login: (cb: OAuthLoginCallbacks) => loginDeepInfra(cb),
} as const satisfies ProviderDefinition;
