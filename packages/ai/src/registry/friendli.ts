import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginFriendli = createApiKeyLogin({
	providerLabel: "FriendliAI",
	authUrl: "https://friendli.ai/suite/~/setting/keys",
	instructions: "Copy your Personal API key from Friendli Suite",
	promptMessage: "Paste your FriendliAI API key",
	placeholder: "flp_...",
	validation: {
		kind: "models-endpoint",
		provider: "FriendliAI",
		modelsUrl: "https://api.friendli.ai/serverless/v1/models",
	},
});

export const friendliProvider = {
	id: "friendli",
	name: "FriendliAI",
	login: (cb: OAuthLoginCallbacks) => loginFriendli(cb),
} as const satisfies ProviderDefinition;
