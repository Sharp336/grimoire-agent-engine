import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginVolcengineAgentPlan = createApiKeyLogin({
	providerLabel: "Volcengine Agent Plan",
	authUrl:
		"https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&OpenModelVisible=false&advancedActiveKey=agentPlan",
	instructions: "Copy your Agent Plan API key from the Volcengine Ark console (separate from Coding Plan key)",
	promptMessage: "Paste your Volcengine Agent Plan API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Volcengine Agent Plan",
		modelsUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/models",
	},
});

export const volcengineAgentPlanProvider = {
	id: "volcengine-agent-plan",
	name: "Volcengine Agent Plan (火山引擎)",
	login: (cb: OAuthLoginCallbacks) => loginVolcengineAgentPlan(cb),
} as const satisfies ProviderDefinition;
