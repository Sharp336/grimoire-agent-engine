import * as AIError from "../error";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://jina.ai/api-dashboard/";

/**
 * Login to Jina Reader.
 *
 * Opens the Jina API dashboard and prompts the user to paste their API key.
 * Returns the key directly (no OAuth involved).
 */
export async function loginJina(options: OAuthLoginCallbacks): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Jina");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Jina Reader API key from the API dashboard.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Jina Reader API key",
		placeholder: "jina_...",
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

export const jinaProvider = {
	id: "jina",
	name: "Jina",
	envKeys: "JINA_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginJina(cb),
} as const satisfies ProviderDefinition;
