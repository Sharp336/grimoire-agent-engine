import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan";
const API_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const VALIDATION_MODEL = "doubao-seed-code";

export const loginVolcengineCodingPlan = createApiKeyLogin({
	providerLabel: "Volcengine Coding Plan",
	authUrl: AUTH_URL,
	instructions: "Copy your API key from the Volcengine Ark console (API Key Management)",
	promptMessage: "Paste your Volcengine API key",
	placeholder: "ark-...",
	validation: {
		kind: "chat-completions",
		provider: "Volcengine",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const volcengineCodingPlanProvider = {
	id: "volcengine-coding-plan",
	name: "Volcengine Coding Plan (火山方舟)",
	login: (cb: OAuthLoginCallbacks) => loginVolcengineCodingPlan(cb),
} as const satisfies ProviderDefinition;
