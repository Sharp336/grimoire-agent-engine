import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import { loginXAIGrokBuild, refreshXAIGrokBuildToken } from "./oauth/xai-oauth";
import type { ProviderDefinition } from "./types";

export const xaiGrokBuildProvider = {
	id: "xai-grok-build",
	name: "xAI Grok Build",
	oauthOnly: true,
	login: (callbacks: OAuthLoginCallbacks) => loginXAIGrokBuild(callbacks),
	refreshToken: (credentials: OAuthCredentials) => refreshXAIGrokBuildToken(credentials.refresh),
} as const satisfies ProviderDefinition;
