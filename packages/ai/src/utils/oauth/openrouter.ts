/**
 * OpenRouter login flow.
 *
 * OpenRouter provides access to 300+ models via a unified OpenAI-compatible API
 * at https://openrouter.ai/api/v1.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to OpenRouter API key settings
 * 2. User copies their API key
 * 3. User pastes the API key into the CLI
 */

import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://openrouter.ai/settings/keys";
const MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * Login to OpenRouter.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginOpenRouter(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("OpenRouter login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from OpenRouter settings",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your OpenRouter API key",
		placeholder: "sk-or-v1-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateApiKeyAgainstModelsEndpoint({
		provider: "OpenRouter",
		apiKey: trimmed,
		modelsUrl: MODELS_URL,
		signal: options.signal,
	});

	return trimmed;
}
