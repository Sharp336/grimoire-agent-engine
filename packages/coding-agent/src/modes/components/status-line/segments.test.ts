import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Goal, GoalModeState } from "../../../goals/state";
import { initTheme } from "../../theme/theme";
import { renderSegment } from "./segments";
import type { SegmentContext } from "./types";

function makeGoal(status: Goal["status"]): Goal {
	return {
		id: "goal-test",
		objective: "Ship goal completion status",
		status,
		tokensUsed: 12,
		timeUsedSeconds: 3,
		createdAt: 1,
		updatedAt: 2,
	};
}

function makeGoalState(status: Goal["status"], enabled: boolean): GoalModeState {
	return {
		enabled,
		mode: status === "complete" ? "exiting" : "active",
		reason: status === "complete" ? "completed" : undefined,
		goal: makeGoal(status),
	};
}

function makeContext(goalState: GoalModeState): SegmentContext {
	const session = {
		getGoalModeState: () => goalState,
		settings: { get: () => false },
	} as unknown as SegmentContext["session"];

	return {
		session,
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
		goalMode: {
			enabled: goalState.enabled,
			paused: goalState.goal.status === "paused",
			status: goalState.goal.status,
		},
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: true,
		subagentCount: 0,
		sessionStartTime: 0,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("status-line goal segments", () => {
	it("renders completed goals even though goal mode is inactive", () => {
		const ctx = makeContext(makeGoalState("complete", false));

		const mode = renderSegment("mode", ctx);
		const goal = renderSegment("goal", ctx);

		expect(mode.visible).toBe(true);
		expect(stripVTControlCharacters(mode.content)).toContain("Goal");
		expect(goal.visible).toBe(true);
		expect(stripVTControlCharacters(goal.content)).toContain("Ship goal completion status");
	});

	it("hides inactive active goals", () => {
		const ctx = makeContext(makeGoalState("active", false));

		expect(renderSegment("mode", ctx).visible).toBe(false);
		expect(renderSegment("goal", ctx).visible).toBe(false);
	});
});
