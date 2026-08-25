import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";

const PROFILE_REPORT_WIDTH = 120;

function safeLabel(value: string): string {
	return replaceTabs(sanitizeText(value).replace(/[\r\n]+/g, " ")).trim();
}

export function formatProfileReport(profile: string, identity: OAuthAccountIdentity | undefined): string {
	const account = identity
		? (identity.email ?? identity.accountId ?? identity.orgName ?? identity.orgId ?? "signed in")
		: "not signed in";
	const accountLabel = safeLabel(account) || (identity ? "signed in" : "not signed in");
	return truncateToWidth(
		`Using profile ${safeLabel(profile)} · Anthropic account: ${accountLabel}`,
		PROFILE_REPORT_WIDTH,
	);
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
