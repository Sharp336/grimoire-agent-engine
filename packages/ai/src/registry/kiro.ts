import { loginKiro, refreshKiroToken } from "./oauth/kiro";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const kiroProvider = {
	id: "kiro",
	name: "Kiro",
	login: (callbacks: OAuthLoginCallbacks) => loginKiro(callbacks),
	refreshToken: (credentials: OAuthCredentials) => refreshKiroToken(credentials),
	getApiKey: (credentials: OAuthCredentials) =>
		JSON.stringify({ accessToken: credentials.access, profileArn: credentials.profileArn }),
} as const satisfies ProviderDefinition;
