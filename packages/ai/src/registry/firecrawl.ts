import * as AIError from "../error";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://firecrawl.dev/settings/api-keys";

/**
 * Login to Firecrawl.
 *
 * Opens the Firecrawl API keys page and prompts the user to paste their API
 * key. Returns the key directly (no OAuth involved). Firecrawl also works
 * keyless; this flow only stores a key when the user supplies one.
 */
export async function loginFirecrawl(options: OAuthLoginCallbacks): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Firecrawl");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Firecrawl API key from the API keys page.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Firecrawl API key",
		placeholder: "fc-...",
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

export const firecrawlProvider = {
	id: "firecrawl",
	name: "Firecrawl",
	envKeys: "FIRECRAWL_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginFirecrawl(cb),
} as const satisfies ProviderDefinition;
