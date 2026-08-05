import * as AIError from "../error";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://api.search.brave.com/app/keys";

/**
 * Login to Brave Search.
 *
 * Opens the Brave Search API keys page and prompts the user to paste their
 * API key. Returns the key directly (no OAuth involved).
 */
export async function loginBrave(options: OAuthLoginCallbacks): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Brave");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Brave Search API key from the API keys page.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Brave Search API key",
		placeholder: "BSA_...",
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	return trimmed;
}

export const braveProvider = {
	id: "brave",
	name: "Brave",
	envKeys: "BRAVE_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginBrave(cb),
} as const satisfies ProviderDefinition;
