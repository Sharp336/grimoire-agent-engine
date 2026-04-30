/**
 * Bailian Coding Plan login flow.
 *
 * Bailian Coding Plan provides models via Anthropic-compatible API:
 * - International: https://coding-intl.dashscope.aliyuncs.com/apps/anthropic/v1
 * - China: https://coding.dashscope.aliyuncs.com/apps/anthropic/v1
 *
 * Uses API keys starting with "sk-sp-" (different from standard DashScope).
 * Does not support "developer" role (must use "system").
 */

import type { OAuthController } from "./types";

const AUTH_URL = "https://modelstudio.console.alibabacloud.com/";
const API_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
const VALIDATION_MODEL = "qwen3-coder-plus";
const VALIDATION_TIMEOUT_MS = 15_000;

async function validateBailianApiKey(options: {
	apiKey: string;
	baseUrl: string;
	signal?: AbortSignal;
}): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	const response = await fetch(`${options.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${options.apiKey}`,
		},
		body: JSON.stringify({
			model: VALIDATION_MODEL,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
		}),
		signal,
	});

	if (response.ok) {
		return;
	}

	let details = "";
	try {
		details = (await response.text()).trim();
	} catch {
		// ignore body parse errors, status is enough
	}

	const message = details
		? `Bailian Coding Plan API key validation failed (${response.status}): ${details}`
		: `Bailian Coding Plan API key validation failed (${response.status})`;
	throw new Error(message);
}
export async function loginBailianCodingPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Bailian Coding Plan login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Alibaba Cloud Bailian Model Studio console (starts with sk-sp-)",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Bailian Coding Plan API key",
		placeholder: "sk-sp-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateBailianApiKey({
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		signal: options.signal,
	});

	return trimmed;
}
