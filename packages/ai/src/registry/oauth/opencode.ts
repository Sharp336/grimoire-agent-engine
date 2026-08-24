/**
 * OpenCode Go login flow.
 *
 * OpenCode Go API keys are issued from the OpenCode Zen console at
 * https://opencode.ai/auth after subscribing to Go (see
 * https://opencode.ai/docs/go).
 * This is not OAuth; it's a simple paste-the-API-key flow:
 * 1. Open browser to https://opencode.ai/auth
 * 2. User logs in (and subscribes to Go, for OpenCode Go) and copies the key
 * 3. User pastes the API key back into the CLI
 */

import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://opencode.ai/auth";

/**
 * Log in to OpenCode Go.
 *
 * Opens the browser to the OpenCode Zen console, prompts the user to paste
 * their API key, and returns it directly (not OAuthCredentials — this isn't
 * OAuth).
 *
 * @param providerName Display name used in the paste prompt.
 */
export async function loginOpenCode(options: OAuthController, providerName: string): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(providerName);
	}

	// Open browser to auth page. Go keys are minted from the same Zen console
	// after subscribing to Go, so the URL is identical for both providers.
	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Log in to the OpenCode Zen console and copy your ${providerName} API key`,
	});

	// Prompt user to paste their API key
	const apiKey = await options.onPrompt({
		message: `Paste your ${providerName} API key`,
		placeholder: "sk-...",
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
