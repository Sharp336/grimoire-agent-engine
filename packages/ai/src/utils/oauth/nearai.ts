import { createApiKeyLogin } from "./api-key-login";

const AUTH_URL = "https://cloud.near.ai";
const API_BASE_URL = "https://cloud-api.near.ai/v1";
const VALIDATION_MODEL = "zai-org/GLM-5.1-FP8";

export const loginNearAI = createApiKeyLogin({
	providerLabel: "NEAR AI Cloud",
	authUrl: AUTH_URL,
	instructions: "Create or copy your NEAR AI Cloud API key",
	promptMessage: "Paste your NEAR AI Cloud API key",
	placeholder: "NEARAI_API_KEY",
	validation: {
		kind: "chat-completions",
		provider: "NEAR AI Cloud",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});
