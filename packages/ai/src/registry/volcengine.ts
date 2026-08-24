import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey";
const MODELS_URL = "https://ark.cn-beijing.volces.com/api/v3/models";

export const loginVolcengine = createApiKeyLogin({
	providerLabel: "Volcengine Ark",
	authUrl: AUTH_URL,
	instructions: "Create or copy your Ark API key from the Volcengine console",
	promptMessage: "Paste your Volcengine Ark API key",
	placeholder: "ark-...",
	validation: {
		kind: "models-endpoint",
		provider: "Volcengine Ark",
		modelsUrl: MODELS_URL,
	},
});

export const volcengineProvider = {
	id: "volcengine",
	name: "Volcengine Ark",
	login: (cb: OAuthLoginCallbacks) => loginVolcengine(cb),
} as const satisfies ProviderDefinition;
