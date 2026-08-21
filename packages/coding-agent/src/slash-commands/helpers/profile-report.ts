import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";

export function formatProfileReport(profile: string, identity: OAuthAccountIdentity | undefined): string {
	const email = identity?.email;
	return `Using profile ${profile} · Anthropic account: ${email ?? "not signed in"}`;
}

export function resolveProfileAnthropicIdentity(
	authStorage: AuthStorage,
	sessionId: string,
): OAuthAccountIdentity | undefined {
	const active = authStorage.getOAuthAccountIdentity("anthropic", sessionId);
	if (active) return active;
	const accounts = authStorage.listOAuthAccounts("anthropic", sessionId);
	return accounts.length === 1 ? accounts[0] : undefined;
}

export function getProfileReport(authStorage: AuthStorage, sessionId: string): string {
	return formatProfileReport(getActiveProfile() ?? "default", resolveProfileAnthropicIdentity(authStorage, sessionId));
}
