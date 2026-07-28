import { $env } from "@oh-my-pi/pi-utils";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

function resolveMoonshotCnModelsUrl(): string {
	const baseUrl = $env.MOONSHOT_CN_BASE_URL?.trim() || "https://api.moonshot.cn/v1";
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export const loginMoonshotCn = createApiKeyLogin({
	providerLabel: "Moonshot (China)",
	authUrl: "https://platform.moonshot.cn/console/api-keys",
	instructions: "Copy your API key from the Moonshot China dashboard",
	promptMessage: "Paste your Moonshot China API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "moonshot-cn",
		modelsUrl: resolveMoonshotCnModelsUrl,
	},
});

export const moonshotCnProvider = {
	id: "moonshot-cn",
	name: "Moonshot (China)",
	login: (cb: OAuthLoginCallbacks) => loginMoonshotCn(cb),
} as const satisfies ProviderDefinition;
