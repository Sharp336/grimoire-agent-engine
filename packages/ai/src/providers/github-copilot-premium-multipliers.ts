// Source of truth (model multiplier section):
// https://docs.github.com/en/copilot/concepts/billing/copilot-requests#model-multipliers
// Structured table backing the docs page:
// https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/model-multipliers.yml
export const COPILOT_PREMIUM_MULTIPLIER_BY_MODEL_ID: Record<string, number> = {
	"claude-haiku-4.5": 0.33,
	"claude-opus-4.5": 3,
	"claude-opus-4.6": 3,
	"claude-sonnet-4": 1,
	"claude-sonnet-4.5": 1,
	"claude-sonnet-4.6": 1,
	"gemini-2.5-pro": 1,
	"gemini-3-flash-preview": 0.33,
	"gemini-3-pro-preview": 1,
	"gemini-3.1-pro-preview": 1,
	"gpt-4.1": 0,
	"gpt-4o": 0,
	"gpt-5-mini": 0,
	"gpt-5.1": 1,
	"gpt-5.1-codex": 1,
	"gpt-5.1-codex-max": 1,
	"gpt-5.1-codex-mini": 0.33,
	"gpt-5.2": 1,
	"gpt-5.2-codex": 1,
	"gpt-5.3-codex": 1,
	"grok-code-fast-1": 0.25,
	"raptor-mini": 0,
};
