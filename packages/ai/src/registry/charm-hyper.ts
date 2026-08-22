import * as AIError from "../error";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthController, OAuthLoginCallbacks, OAuthPrompt } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const innerLogin = createApiKeyLogin({
	providerLabel: "Charm Hyper",
	authUrl: "https://hyper.charm.land/",
	instructions:
		"Create or copy your API key from the Hyper dashboard (hyper.charm.land is Charm's public inference gateway, unaffiliated with this project)",
	promptMessage: "Paste your Hyper API key",
	placeholder: "sk-hyper-...",
	validation: {
		kind: "models-endpoint",
		provider: "charm-hyper",
		modelsUrl: "https://hyper.charm.land/v1/credits",
	},
});

export function normalizeHyperApiKey(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return trimmed;
	}
	const stripped = trimmed.replace(/^bearer\b\s*/i, "");
	if (!stripped) {
		throw new AIError.ApiKeyRequiredError("Hyper API key is empty after stripping Bearer prefix");
	}
	return stripped;
}

export const loginHyper = async (options: OAuthController): Promise<string> => {
	const userOnPrompt = options.onPrompt;
	const wrapped: OAuthController = userOnPrompt
		? {
				...options,
				onPrompt: async (prompt: OAuthPrompt) => normalizeHyperApiKey(await userOnPrompt(prompt)),
			}
		: options;
	return innerLogin(wrapped);
};

export const charmHyperProvider = {
	id: "charm-hyper",
	name: "Charm Hyper",
	login: (cb: OAuthLoginCallbacks) => loginHyper(cb),
} as const satisfies ProviderDefinition;
