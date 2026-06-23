import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://www.byteplus.com/en/activity/codingplan";
const API_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3";
const VALIDATION_MODEL = "ark-code-latest";

export const loginBytePlusCodingPlan = createApiKeyLogin({
	providerLabel: "BytePlus Coding Plan",
	authUrl: AUTH_URL,
	instructions: "Subscribe to ModelArk Coding Plan and copy your API key",
	promptMessage: "Paste your BytePlus Coding Plan API key",
	placeholder: "ARK_API_KEY",
	validation: {
		kind: "chat-completions",
		provider: "BytePlus Coding Plan",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const byteplusCodingPlanProvider = {
	id: "byteplus-coding-plan",
	name: "BytePlus Coding Plan",
	login: (cb: OAuthLoginCallbacks) => loginBytePlusCodingPlan(cb),
} as const satisfies ProviderDefinition;
