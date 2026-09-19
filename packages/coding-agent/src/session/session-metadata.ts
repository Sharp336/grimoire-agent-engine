import { deriveClaudeDeviceId } from "@oh-my-pi/pi-ai";
import { getInstallId } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "./auth-storage";

export function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both omp's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
}
