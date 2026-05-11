import { prompt } from "@oh-my-pi/pi-utils";
import budgetLimitPrompt from "../prompts/goals/budget_limit.md" with { type: "text" };
import continuationPrompt from "../prompts/goals/continuation.md" with { type: "text" };
import type { ThreadGoal } from "./types";

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function goalPromptData(goal: ThreadGoal): Record<string, string | number> {
	const remainingTokens = goal.tokenBudget === null ? "unbounded" : Math.max(0, goal.tokenBudget - goal.tokensUsed);
	return {
		objective: escapeXml(goal.objective),
		time_used_seconds: goal.timeUsedSeconds,
		tokens_used: goal.tokensUsed,
		token_budget: goal.tokenBudget ?? "none",
		remaining_tokens: remainingTokens,
	};
}

export function renderGoalContinuationPrompt(goal: ThreadGoal): string {
	return prompt.render(continuationPrompt, goalPromptData(goal));
}

export function renderGoalBudgetLimitPrompt(goal: ThreadGoal): string {
	return prompt.render(budgetLimitPrompt, goalPromptData(goal));
}
