import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthClientProfile } from "@oh-my-pi/pi-ai/oauth/types";

export interface OAuthProviderStorageTarget {
	provider: string;
	clientProfile?: OAuthClientProfile;
}

/** Resolve a login-facing provider id to its persisted credential namespace. */
export function resolveOAuthProviderStorage(providerId: string): OAuthProviderStorageTarget {
	if (providerId === "anthropic") {
		return { provider: "anthropic", clientProfile: "claude-code" };
	}
	if (providerId === "anthropic-cowork") {
		return { provider: "anthropic", clientProfile: "cowork" };
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
	return { provider: provider?.storeCredentialsAs ?? providerId };
}
