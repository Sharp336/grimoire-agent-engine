/** Kimi Code API key login flow (paste key from https://www.kimi.com/code/console). */
import { createApiKeyLogin } from "./api-key-login";

export const loginKimiApiKey = createApiKeyLogin({
	providerLabel: "Kimi Code",
	authUrl: "https://www.kimi.com/code/console",
	instructions: "Create an API key from your Kimi Code console and paste it below.",
	promptMessage: "Paste your Kimi Code API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "kimi-code",
		modelsUrl: "https://api.kimi.com/coding/v1/models",
	},
});
