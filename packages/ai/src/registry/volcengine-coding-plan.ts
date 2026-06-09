import { volcengineCodingPlanModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const loginVolcengineCodingPlan = createApiKeyLogin({
	providerLabel: "Volcengine Coding Plan",
	authUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
	instructions: "Copy your API key from the Volcengine Ark console",
	promptMessage: "Paste your Volcengine API key",
	placeholder: "sk-...",
	validation: {
		kind: "anthropic-messages",
		provider: "Volcengine Coding Plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
		model: "doubao-seed-2.0-code",
		authStyle: "bearer",
	},
});

export const volcengineCodingPlanProvider = {
	id: "volcengine-coding-plan",
	name: "Volcengine Coding Plan (火山引擎)",
	defaultModel: "doubao-seed-2.0-code",
	createModelManagerOptions: (config: ModelManagerConfig) => volcengineCodingPlanModelManagerOptions(config),
	catalogDiscovery: { label: "Volcengine Coding Plan", envVars: ["VOLCENGINE_API_KEY"] },
	envKeys: "VOLCENGINE_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginVolcengineCodingPlan(cb),
} as const satisfies ProviderDefinition;
