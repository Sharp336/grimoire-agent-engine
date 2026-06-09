import { volcengineCodingPlanModelManagerOptions } from "../provider-models/openai-compat";
import { validateAnthropicCompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const AUTH_URL = "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey";
const API_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding";
const VALIDATION_MODEL = "doubao-seed-2.0-code";

export async function loginVolcengineCodingPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Volcengine Coding Plan login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Volcengine Ark console",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Volcengine API key",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateAnthropicCompatibleApiKey({
		provider: "Volcengine Coding Plan",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});
	return trimmed;
}

export const volcengineCodingPlanProvider = {
	id: "volcengine-coding-plan",
	name: "Volcengine Coding Plan (火山引擎)",
	defaultModel: "doubao-seed-2.0-code",
	createModelManagerOptions: (config: ModelManagerConfig) => volcengineCodingPlanModelManagerOptions(config),
	catalogDiscovery: { label: "Volcengine Coding Plan", envVars: ["VOLCENGINE_API_KEY"] },
	envKeys: "VOLCENGINE_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginVolcengineCodingPlan(cb),
} as const satisfies ProviderDefinition;
