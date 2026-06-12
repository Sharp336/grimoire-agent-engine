import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/** Requesty login flow (API key paste, no server-side validation).
 *
 * `/v1/models` is public (200 for any bearer) and the management API
 * requires elevated key permissions, so there is no cheap validation
 * endpoint. The key is accepted as-is; an invalid key surfaces as an
 * auth error on the first real request.
 */
export const loginRequesty = createApiKeyLogin({
	providerLabel: "Requesty",
	authUrl: "https://app.requesty.ai/api-keys",
	instructions: "Create or copy your Requesty API key",
	promptMessage: "Paste your Requesty API key",
	placeholder: "rqsty-sk-...",
	validation: null,
});

export const requestyProvider = {
	id: "requesty",
	name: "Requesty",
	login: (cb: OAuthLoginCallbacks) => loginRequesty(cb),
} as const satisfies ProviderDefinition;
