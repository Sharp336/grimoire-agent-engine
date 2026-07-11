import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";
export const XAI_GROK_BUILD_CALLBACK_PORT = 8086;

export const xaiGrokBuildProvider = {
	id: "xai-grok-build",
	name: "xAI Grok Build",
	oauthOnly: true,
	login: async (callbacks: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXAIGrokBuild } = await import("./oauth/xai-oauth");
		return loginXAIGrokBuild(callbacks, XAI_GROK_BUILD_CALLBACK_PORT);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshXAIGrokBuildToken } = await import("./oauth/xai-oauth");
		return refreshXAIGrokBuildToken(credentials.refresh);
	},
	callbackPort: XAI_GROK_BUILD_CALLBACK_PORT,
} as const satisfies ProviderDefinition;
