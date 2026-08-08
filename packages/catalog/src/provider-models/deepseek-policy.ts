import type { Api, ModelSpec, OpenAICompat } from "../types";

const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_V4_CONTEXT_WINDOW = 1_000_000;
const DEEPSEEK_V4_MAX_TOKENS = 384_000;
const DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);

/**
 * Transport requirements shared by first-party DeepSeek V4 models.
 *
 * Keep these as sparse model-spec overrides. `buildModel()` merges them with
 * URL/model-family detection, which owns the conditional thinking toggle and
 * the wire-exact effort ladder for each V4 SKU.
 */
const DEEPSEEK_V4_COMPAT: OpenAICompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	maxTokensField: "max_tokens",
	supportsToolChoice: false,
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: true,
	requiresReasoningContentForAllAssistantTurns: true,
	allowsSyntheticReasoningContentForToolCalls: false,
	requiresAssistantContentForToolCalls: true,
};

/**
 * Make the bundled first-party DeepSeek V4 contract authoritative.
 *
 * The generated catalog and `/models` discovery are both external metadata
 * sources and may lag or carry obsolete effort aliases. Applying this policy
 * before `buildModel()` guarantees that offline model resolution and live
 * discovery agree on DeepSeek's endpoint, limits, and tool-call replay shape.
 * Pricing and unrelated model metadata are retained; generated thinking and
 * compat metadata are reset so the current builder derives the wire-exact V4
 * effort ladder and conditional thinking toggle.
 */
export function applyDeepSeekV4BuiltinPolicy(
	provider: string,
	modelId: string,
	model: ModelSpec<Api>,
): ModelSpec<Api> {
	if (provider !== "deepseek" || !DEEPSEEK_V4_MODEL_IDS.has(modelId)) {
		return model;
	}

	return {
		...model,
		id: modelId,
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: DEEPSEEK_API_BASE_URL,
		reasoning: true,
		thinking: undefined,
		input: ["text"],
		contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW,
		maxTokens: DEEPSEEK_V4_MAX_TOKENS,
		compat: { ...DEEPSEEK_V4_COMPAT },
	};
}
