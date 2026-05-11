export const GOAL_STATUSES = ["active", "paused", "budget_limited", "complete"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface ThreadGoal {
	threadId: string;
	goalId: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalToolResponse {
	goal: ThreadGoal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}
