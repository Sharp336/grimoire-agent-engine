import { $env } from "@oh-my-pi/pi-utils";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export function getXAIOAuthEnvBearer(): string | undefined {
	const token = $env.XAI_OAUTH_TOKEN?.trim();
	if (!token || token.startsWith("{") || token.startsWith("[")) return undefined;
	return token;
}

export const xaiOauthProvider = {
	id: "xai-oauth",
	name: "xAI Grok OAuth (SuperGrok or X Premium+)",
	envKeys: () => getXAIOAuthEnvBearer() ?? $env.XAI_API_KEY,
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXAIOAuth } = await import("./oauth/xai-oauth");
		return loginXAIOAuth(cb);
	},
	refreshToken: async (credentials: OAuthCredentials, signal?: AbortSignal) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshXAIOAuthToken } = await import("./oauth/xai-oauth");
		return refreshXAIOAuthToken(credentials.refresh, undefined, signal);
	},
} as const satisfies ProviderDefinition;
