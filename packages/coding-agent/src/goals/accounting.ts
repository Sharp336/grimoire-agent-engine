import type { Usage } from "@oh-my-pi/pi-ai";

export interface GoalAccountingDelta {
	tokens: number;
}

export function calculateGoalTokenDelta(previous: Usage, current: Usage): GoalAccountingDelta {
	const nonCachedInput = Math.max(current.input - current.cacheRead - previous.input + previous.cacheRead, 0);
	const cacheWrite = Math.max(current.cacheWrite - previous.cacheWrite, 0);
	const output = Math.max(current.output - previous.output, 0);
	return { tokens: nonCachedInput + cacheWrite + output };
}
