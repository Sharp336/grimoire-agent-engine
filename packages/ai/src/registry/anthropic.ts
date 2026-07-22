import { $pickenv } from "@oh-my-pi/pi-utils";
import { isFoundryEnabled } from "../utils/foundry";
import { loginAnthropic, loginAnthropicCowork, refreshAnthropicToken } from "./oauth/anthropic";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const anthropicProvider = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	// Foundry mode optionally switches Anthropic auth to enterprise gateway credentials.
	envKeys: () =>
		isFoundryEnabled()
			? $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
			: $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"),
	login: async (cb: OAuthLoginCallbacks) => loginAnthropic(cb),
	refreshToken: async (credentials: OAuthCredentials) =>
		refreshAnthropicToken(credentials.refresh, undefined, credentials.clientProfile ?? "claude-code"),
	callbackPort: 54545,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;

export const anthropicCoworkProvider = {
	id: "anthropic-cowork",
	name: "Anthropic (Cowork)",
	login: async (cb: OAuthLoginCallbacks) => loginAnthropicCowork(cb),
	refreshToken: async (credentials: OAuthCredentials) =>
		refreshAnthropicToken(credentials.refresh, undefined, "cowork"),
	storeCredentialsAs: "anthropic",
	callbackPort: 54545,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
