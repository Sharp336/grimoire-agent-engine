/**
 * 9Router login flow.
 *
 * 9Router is a local OpenAI-compatible AI router running on port 20128.
 * Authentication is optional (disabled by default).
 *
 * This flow stores an API-key-style credential used by `/login` and auth storage.
 */

import type { OAuthController, OAuthProvider } from "./types";

const PROVIDER_ID: OAuthProvider = "9router";
const AUTH_URL = "http://localhost:20128/docs";
const DEFAULT_LOCAL_BASE_URL = "http://localhost:20128/v1";
const DEFAULT_LOCAL_TOKEN = "9router-local";

/**
 * Login to 9Router.
 *
 * Opens 9Router dashboard/docs, prompts for an optional API key,
 * and returns a stored key value.
 */
export async function login9Router(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error(`${PROVIDER_ID} login requires onPrompt callback`);
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Paste your 9Router API key if auth is enabled. Leave empty for local no-auth mode (default base URL: ${DEFAULT_LOCAL_BASE_URL}).`,
	});
	const apiKey = await options.onPrompt({
		message: "Paste your 9Router API key (optional for local no-auth)",
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}
