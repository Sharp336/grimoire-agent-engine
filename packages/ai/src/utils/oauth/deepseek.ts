/** DeepSeek login flow (API key paste against https://api.deepseek.com). */
import { createApiKeyLogin } from "./api-key-login";

export const loginDeepSeek = createApiKeyLogin({
	providerLabel: "DeepSeek",
	authUrl: "https://platform.deepseek.com/api_keys",
	instructions: "Copy your API key from the DeepSeek dashboard",
	promptMessage: "Paste your DeepSeek API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		model: "deepseek-v4-flash",
	},
});
