import type { GoalToolResponse, ThreadGoal } from "./types";

export function goalToolResponse(goal: ThreadGoal | null, includeCompletionReport: boolean): GoalToolResponse {
	const remainingTokens =
		goal?.tokenBudget === null || goal === null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed);
	return {
		goal,
		remainingTokens,
		completionBudgetReport:
			includeCompletionReport && goal
				? `Goal completed using ${goal.tokensUsed} tokens and ${goal.timeUsedSeconds} seconds.`
				: null,
	};
}
