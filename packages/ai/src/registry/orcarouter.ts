import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Cheapest generally-available route on the gateway; the validation request
 * caps `max_tokens` at 1. `orcarouter/*` meta-models are deliberately avoided:
 * `orcarouter/free` answers 403 `free_quota_exhausted` once the free allowance
 * is spent, which would reject a perfectly valid key.
 */
const VALIDATION_MODEL = "google/gemini-3.5-flash-lite";

/** OrcaRouter login flow (API key paste, validated via chat completions).
 *
 * `/v1/models` is public and answers 200 without an Authorization header, so
 * it cannot validate auth. A minimal `/v1/chat/completions` call can: the
 * gateway returns 401 `Invalid token` for an unknown key and 200 for a valid
 * one.
 */
export const loginOrcaRouter = createApiKeyLogin({
	providerLabel: "OrcaRouter",
	authUrl: "https://www.orcarouter.ai",
	instructions: "Create or copy your OrcaRouter API key",
	promptMessage: "Paste your OrcaRouter API key",
	placeholder: "sk-orca-...",
	validation: {
		kind: "chat-completions",
		provider: "OrcaRouter",
		baseUrl: "https://api.orcarouter.ai/v1",
		model: VALIDATION_MODEL,
	},
});

export const orcarouterProvider = {
	id: "orcarouter",
	name: "OrcaRouter",
	login: (cb: OAuthLoginCallbacks) => loginOrcaRouter(cb),
} as const satisfies ProviderDefinition;
