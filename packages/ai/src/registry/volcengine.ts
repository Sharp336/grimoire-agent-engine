import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginVolcengine = createApiKeyLogin({
	providerLabel: "Volcengine Ark",
	authUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
	instructions: "Create or copy your API key from the Volcengine Ark console",
	promptMessage: "Paste your Volcengine Ark API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Volcengine Ark",
		modelsUrl: "https://ark.cn-beijing.volces.com/api/v3/models",
	},
});

export const volcengineProvider = {
	id: "volcengine",
	name: "Volcengine Ark (火山引擎方舟)",
	login: (cb: OAuthLoginCallbacks) => loginVolcengine(cb),
} as const satisfies ProviderDefinition;
