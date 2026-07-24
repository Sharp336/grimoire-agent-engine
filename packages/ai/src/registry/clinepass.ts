import { createApiKeyLogin } from "./api-key-login";
import { validateOpenAICompatibleApiKey } from "./api-key-validation";
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
/**
 * ClinePass chat-completions probe — shared by the API-key and imported-WorkOS
 * validation paths. ClinePass routes runtime requests through
 * `max_completion_tokens`, and its reasoning models 5xx with "empty response
 * content" when a 1-token budget leaves no room after thinking, so the probe
 * uses the runtime token field with a real budget.
 */
const CLINEPASS_PROBE = {
	provider: "ClinePass",
	baseUrl: "https://api.cline.bot/api/v1",
	model: "cline-pass/glm-5.2",
	maxTokensField: "max_completion_tokens",
	maxTokens: 256,
} as const;

export const loginClinepassApiKey = createApiKeyLogin({
	providerLabel: "ClinePass",
	authUrl: "https://app.cline.bot/dashboard/account",
	instructions: "Create a ClinePass API key in the Cline dashboard (Settings → API Keys)",
	promptMessage: "Paste your ClinePass API key",
	placeholder: "sk_...",
	validation: { kind: "chat-completions", ...CLINEPASS_PROBE },
});

/**
 * Try the Cline CLI's WorkOS credentials first, validating the imported token
 * against the ClinePass gateway. Falls back to the manual API-key paste flow
 * when the CLI isn't logged in or the account has no ClinePass subscription.
 */
export async function loginClinepass(
	cb: Parameters<typeof loginClinepassApiKey>[0],
	options: { loginFromCli?: typeof loginFromClineCli } = {},
): Promise<OAuthCredentials | string> {
	try {
		const workos = await (options.loginFromCli ?? loginFromClineCli)({ fetch: cb.fetch });
		if (workos) {
			// The Cline CLI's WorkOS token also covers Cline's separate
			// usage-billing provider; validate it against the ClinePass gateway so
			// an account without a ClinePass subscription falls through to the
			// static-key path instead of shadowing a valid key until logout.
			await validateOpenAICompatibleApiKey({
				...CLINEPASS_PROBE,
				apiKey: workos.access,
				fetch: cb.fetch,
				signal: cb.signal,
			});
			return workos;
		}
	} catch {
		// Stale/revoked Cline CLI credentials, or the account has no ClinePass
		// subscription — both fall through to the supported static-key path, which
		// validates the replacement key itself.
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
