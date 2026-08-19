import * as AIError from "../../error";
import { ProviderHttpError } from "../../error/classes";
import { createApiKeyLogin } from "../api-key-login";
import type { OAuthController } from "./types";

const VALIDATION_TIMEOUT_MS = 10_000;

// BFL reads only the x-key header; Authorization: Bearer is ignored.
async function validateBflApiKey(apiKey: string, options: OAuthController): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? fetch;

	let response: Response;
	try {
		response = await fetchImpl("https://api.bfl.ai/v1/credits", {
			method: "GET",
			headers: { "x-key": apiKey },
			signal,
		});
	} catch {
		if (options.signal?.aborted) throw new AIError.LoginCancelledError();
		return; // fail open: connectivity must not block storing a pasted key
	}

	if (response.status !== 401 && response.status !== 403 && response.status !== 422) {
		return; // 200 = valid; 5xx/429 fail open
	}

	let detail = "";
	try {
		const body = (await response.json()) as { detail?: unknown };
		if (typeof body.detail === "string") detail = body.detail;
	} catch {
		// keep the HTTP status as the failure category
	}

	const message = detail
		? `Black Forest Labs API key validation failed (${response.status}): ${detail}`
		: `Black Forest Labs API key validation failed (${response.status})`;
	throw new ProviderHttpError(message, response.status, { headers: response.headers });
}

const pasteBflKey = createApiKeyLogin({
	providerLabel: "Black Forest Labs",
	authUrl: "https://dashboard.bfl.ai/keys",
	instructions: "Create or copy an API key in the BFL dashboard, then paste it here.",
	promptMessage: "Paste your BFL API key",
	placeholder: "API key from dashboard.bfl.ai/keys",
	validation: null,
});

export async function loginBfl(options: OAuthController): Promise<string> {
	const key = await pasteBflKey(options);
	options.onProgress?.("Validating API key...");
	await validateBflApiKey(key, options);
	return key;
}
