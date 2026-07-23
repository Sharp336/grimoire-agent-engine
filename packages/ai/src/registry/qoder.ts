import { loginQoder, refreshQoderToken } from "./oauth/qoder";
import type { OAuthCredentials } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const qoderProvider = {
	id: "qoder",
	name: "Qoder (qoder.com)",
	login: loginQoder,
	refreshToken: async (credentials: OAuthCredentials) => refreshQoderToken(credentials.refresh),
} as const satisfies ProviderDefinition;
