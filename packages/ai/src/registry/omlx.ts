import type { OAuthController } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const OMLX_DOCS_URL = "https://github.com/jundot/omlx";

/**
 * Login to OMLX (MLX inference server for Apple Silicon).
 *
 * Returns a trimmed API key/token string. Empty string means local no-auth mode.
 */
export async function loginOmlx(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	if (!options.onPrompt) {
		return "";
	}

	options.onAuth?.({
		url: OMLX_DOCS_URL,
		instructions:
			"Optional: paste an OMLX API key if your server requires authentication. Leave empty for local no-auth mode.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your OMLX API key (optional)",
		placeholder: "omlx-local",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	return apiKey.trim();
}

export const omlxProvider = {
	id: "omlx",
	name: "OMLX (MLX Inference Server)",
	login: loginOmlx,
} as const satisfies ProviderDefinition;
