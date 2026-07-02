import * as AIError from "../error";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://you.com/platform";

/**
 * Login to You.com.
 *
 * Opens browser to the You.com platform dashboard and prompts the user to
 * paste their API key. Returns the API key directly (not OAuthCredentials -
 * this isn't OAuth).
 */
export async function loginYou(options: OAuthLoginCallbacks): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("You.com");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your You.com API key from the You.com platform dashboard.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your You.com API key",
		placeholder: "ydc-sk-...",
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

export const ydcProvider = {
	id: "ydc",
	name: "You.com",
	envKeys: "YDC_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginYou(cb),
} as const satisfies ProviderDefinition;
