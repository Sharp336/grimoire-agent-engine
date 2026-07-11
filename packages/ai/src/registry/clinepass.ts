import { createApiKeyLogin } from "./api-key-login";
import { isWorkosToken, loginFromClineCli, refreshWorkosToken } from "./oauth/clinepass";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * ClinePass login flow.
 *
 * ClinePass is Cline's flat-rate ($9.99/mo) subscription that re-hosts open
 * coding models behind one OpenAI-compatible endpoint at
 * `https://api.cline.bot/api/v1`. Two auth methods are supported:
 *
 * - **WorkOS OAuth (automatic)** — if the Cline CLI (`cline auth`) is logged in,
 *   its WorkOS credentials are reused, refreshed on expiry via
 *   `POST /api/v1/auth/refresh` (see `./oauth/clinepass`). No API key needed.
 * - **Static API key (manual)** — `sk_…` keys from the Cline dashboard. The key
 *   does NOT authorize `/v1/models` (discovery 404s), so validation pings the
 *   chat completions endpoint with the default model directly.
 *
 * See https://docs.cline.bot/getting-started/clinepass.
 */
export const loginClinepassApiKey = createApiKeyLogin({
	providerLabel: "ClinePass",
	authUrl: "https://app.cline.bot/dashboard/account",
	instructions: "Create a ClinePass API key in the Cline dashboard (Settings → API Keys)",
	promptMessage: "Paste your ClinePass API key",
	placeholder: "sk_...",
	validation: {
		kind: "chat-completions",
		provider: "ClinePass",
		baseUrl: "https://api.cline.bot/api/v1",
		model: "cline-pass/glm-5.2",
		// ClinePass routes runtime requests through `max_completion_tokens`, and its
		// reasoning models 5xx with "empty response content" when a 1-token budget
		// leaves no room after thinking. Validate with the runtime field and a real
		// budget so a valid key is never rejected during /login.
		maxTokensField: "max_completion_tokens",
		maxTokens: 256,
	},
});

/**
 * Try the Cline CLI's WorkOS credentials first; if the user is not logged in
 * with `cline auth`, fall back to the manual API-key paste flow.
 */
export async function loginClinepass(
	cb: Parameters<typeof loginClinepassApiKey>[0],
	options: { loginFromCli?: typeof loginFromClineCli } = {},
): Promise<OAuthCredentials | string> {
	try {
		const workos = await (options.loginFromCli ?? loginFromClineCli)({ fetch: cb.fetch });
		if (workos) return workos;
	} catch {
		// Stale or revoked Cline CLI credentials must not block the supported
		// static-key path. The manual prompt validates the replacement key.
	}
	return loginClinepassApiKey(cb);
}

export const clinepassProvider = {
	id: "clinepass",
	name: "ClinePass (Cline subscription gateway)",
	login: (cb: OAuthLoginCallbacks) => loginClinepass(cb),
	refreshToken: async (credentials: OAuthCredentials) => {
		// Static API keys never expire and take the manual path; only WorkOS
		// (`workos:`-prefixed) access tokens are refreshable.
		if (isWorkosToken(credentials.access)) return refreshWorkosToken(credentials);
		return credentials;
	},
} as const satisfies ProviderDefinition;
