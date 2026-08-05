import * as AIError from "../error";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://tinyfish.ai/";

/**
 * Login to TinyFish.
 *
 * Opens the TinyFish site and prompts the user to paste their API key.
 * Returns the key directly (no OAuth involved).
 */
export async function loginTinyFish(options: OAuthLoginCallbacks): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("TinyFish");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your TinyFish API key.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your TinyFish API key",
		placeholder: "tf-...",
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

export const tinyfishProvider = {
	id: "tinyfish",
	name: "TinyFish",
	envKeys: "TINYFISH_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginTinyFish(cb),
} as const satisfies ProviderDefinition;
