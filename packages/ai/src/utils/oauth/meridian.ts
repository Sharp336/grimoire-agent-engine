/**
 * Meridian login flow.
 *
 * Meridian is a local Anthropic-compatible proxy. It defaults to
 * http://127.0.0.1:3456 and accepts any placeholder API key value because
 * authentication happens through the local Claude Code session.
 */

import type { OAuthController } from "./types";

const AUTH_URL = "https://github.com/rynfar/meridian";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:3456";
const DEFAULT_PLACEHOLDER_TOKEN = "x";

export async function loginMeridian(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Meridian login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Start Meridian locally, then point the provider at ${DEFAULT_LOCAL_BASE_URL}. Meridian accepts any placeholder API key, so the default token "${DEFAULT_PLACEHOLDER_TOKEN}" is sufficient.`,
	});

	const apiKey = await options.onPrompt({
		message:
			"Optional: paste a Meridian placeholder API key (press enter to use x; set MERIDIAN_BASE_URL to change the endpoint)",
		placeholder: DEFAULT_PLACEHOLDER_TOKEN,
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_PLACEHOLDER_TOKEN;
}
