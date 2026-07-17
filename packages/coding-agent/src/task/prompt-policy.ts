import {
	bareModelId,
	isClaudeModelId,
	isKimiModelId,
	isOpenAIModelId,
	parseGlmModel,
	parseOpenAIModel,
	semverEqual,
} from "@oh-my-pi/pi-catalog/identity";

/** Whether task guidance should follow Codex's GPT-5.6-specific delegation policy. */
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const parsed = parseOpenAIModel(bareModelId(modelId));
	return parsed !== null && semverEqual(parsed.version, "5.6");
}

/** Prompt dialect for the system prompt's eval-first batching section. */
export type EvalPromptStyle = "default" | "claude" | "codex" | "kimi";

/**
 * Selects the eval-first batching dialect for a model:
 * - `claude`: Claude/GLM — XML-tagged block with direct imperatives (both are
 *   steered most reliably by explicit tagged directives).
 * - `codex`: OpenAI reasoning families — terse bounded rules, no emphasis spam.
 * - `kimi`: Kimi K-series — positive operational constraints; all-caps NEVER
 *   directives make K2.x overthink instead of comply.
 * - `default`: everything else — maximum-emphasis fallback.
 */
export function evalPromptStyle(modelId: string | undefined): EvalPromptStyle {
	if (!modelId) return "default";
	if (isClaudeModelId(modelId) || parseGlmModel(bareModelId(modelId)) !== null) return "claude";
	if (isKimiModelId(modelId)) return "kimi";
	if (isOpenAIModelId(modelId)) return "codex";
	return "default";
}
