const MAX_OBJECTIVE_LENGTH = 20_000;

export function validateGoalObjective(objective: string): string {
	const trimmed = objective.trim();
	if (trimmed.length === 0) {
		throw new Error("Goal objective cannot be empty.");
	}
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		throw new Error(`Goal objective cannot exceed ${MAX_OBJECTIVE_LENGTH} characters.`);
	}
	return trimmed;
}

export function validateTokenBudget(tokenBudget: number | null | undefined): number | null {
	if (tokenBudget === undefined || tokenBudget === null) return null;
	if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	return tokenBudget;
}
