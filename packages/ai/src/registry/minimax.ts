import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/** MiniMax login flow (API key paste, validated via the anthropic-compatible messages endpoint). */
export const loginMiniMax = createApiKeyLogin({
	providerLabel: "MiniMax",
	authUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
	instructions: "Create or copy your API key from the MiniMax platform",
	promptMessage: "Paste your MiniMax API key",
	placeholder: "sk-...",
	validation: {
		kind: "anthropic-messages",
		provider: "MiniMax",
		baseUrl: "https://api.minimax.io/anthropic",
		model: "MiniMax-M3",
	},
});

export const minimaxProvider = {
	id: "minimax",
	name: "MiniMax",
	login: (cb: OAuthLoginCallbacks) => loginMiniMax(cb),
} as const satisfies ProviderDefinition;
