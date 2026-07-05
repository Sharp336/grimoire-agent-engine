import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * ClinePass login flow.
 *
 * ClinePass is Cline's flat-rate ($9.99/mo) subscription that re-hosts open
 * coding models behind one OpenAI-compatible endpoint at
 * `https://api.cline.bot/api/v1`. The `sk_…` API key does NOT authorize
 * `/v1/models` (discovery 404s), so validation pings the chat completions
 * endpoint with the default model directly.
 * See https://docs.cline.bot/getting-started/clinepass.
 */
export const loginClinepass = createApiKeyLogin({
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

export const clinepassProvider = {
	id: "clinepass",
	name: "ClinePass (Cline subscription gateway)",
	login: (cb: OAuthLoginCallbacks) => loginClinepass(cb),
} as const satisfies ProviderDefinition;
