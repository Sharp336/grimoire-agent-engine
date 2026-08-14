import { ALIBABA_TOKEN_PLAN_CN_BASE_URL } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import * as AIError from "../error";
import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const CHINA_AUTH_URL = "https://www.aliyun.com/benefit/scene/tokenplan";

/**
 * Log in to the dedicated Bailian (China) Token Plan provider.
 *
 * Mirrors {@link loginAlibabaTokenPlan}'s region-2 flow without the region
 * prompt: the provider's default base URL is already the China (Beijing)
 * endpoint, so a bare key authenticates directly. The QwenCloud cookie-based
 * quota reporting step is intentionally omitted — that console API is
 * international-only and Bailian usage is tracked in the Aliyun console.
 */
export async function loginBailianTokenPlanCn(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Bailian-Token-Plan-CN");
	}

	options.onAuth?.({
		url: CHINA_AUTH_URL,
		instructions: "Subscribe to the 百炼 Token Plan and copy its dedicated API key",
	});

	const apiKeyInput = await options.onPrompt({
		message: "Paste your Bailian Token Plan API key",
		placeholder: "sk-sp-...",
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const apiKey = apiKeyInput.trim();
	if (!apiKey) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.("Validating API key...");
	await validateApiKeyAgainstModelsEndpoint({
		provider: "Bailian-Token-Plan-CN",
		apiKey,
		modelsUrl: `${ALIBABA_TOKEN_PLAN_CN_BASE_URL}/models`,
		signal: options.signal,
		fetch: options.fetch,
	});

	return apiKey;
}

export const bailianTokenPlanCnProvider = {
	id: "bailian-token-plan-cn",
	name: "Bailian-Token-Plan-CN",
	login: (cb: OAuthLoginCallbacks) => loginBailianTokenPlanCn(cb),
} as const satisfies ProviderDefinition;
