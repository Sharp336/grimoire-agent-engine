/**
 * Ollama Cloud login flow.
 *
 * Ollama Cloud (https://ollama.com/v1) is an OpenAI-compatible API that
 * requires an API key for authentication.
 *
 * This flow is API-key based (not OAuth):
 * 1. Optionally open Ollama Cloud docs
 * 2. Prompt user for API key
 * 3. Persist key
 */

import type { OAuthController } from "./types";

const OLLAMA_CLOUD_URL = "https://ollama.com/settings/keys";

/**
 * Login to Ollama Cloud.
 *
 * Returns an API key string. Empty string means no key provided.
 */
export async function loginOllamaCloud(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	if (!options.onPrompt) {
		return "";
	}

	options.onAuth?.({
		url: OLLAMA_CLOUD_URL,
		instructions: "Paste your Ollama Cloud API key from your account settings.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Ollama Cloud API key",
		placeholder: "ollama-cloud-...",
		allowEmpty: false,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	return apiKey.trim();
}
