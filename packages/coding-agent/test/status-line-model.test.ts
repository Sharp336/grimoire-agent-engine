import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createGoalState(objective: string): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-1",
			objective,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 0,
			updatedAt: 0,
		},
	};
}

function createContext(options?: {
	advisorActive?: boolean;
	goalState?: GoalModeState | null;
	goalMode?: SegmentContext["goalMode"];
	segmentOptions?: SegmentContext["options"];
}): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => options?.advisorActive ?? false,
			getGoalModeState: () => options?.goalState ?? undefined,
			settings: { get: () => false },
		} as unknown as SegmentContext["session"],
		width: 120,
		options: options?.segmentOptions ?? {},
		planMode: null,
		loopMode: null,
		goalMode: options?.goalMode ?? null,
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
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line model segment advisor badge", () => {
	it("appends a success-colored ++ badge when the advisor is active", () => {
		const rendered = renderSegment("model", createContext({ advisorActive: true }));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).toContain(theme.fg("success", "++"));
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderSegment("model", createContext({ advisorActive: false }));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).not.toContain("++");
	});
});

describe("status line goal segment", () => {
	it("sanitizes and truncates the active goal objective", () => {
		const rendered = renderSegment(
			"goal",
			createContext({
				goalState: createGoalState("Ship\tauth\nhardening now"),
				goalMode: { enabled: true, paused: false },
				segmentOptions: { goal: { maxLength: 10 } },
			}),
		);
		const plain = stripVTControlCharacters(rendered.content);
		expect(rendered.visible).toBe(true);
		expect(plain).toContain("Ship auth…");
		expect(plain).not.toContain("\n");
		expect(plain).not.toContain("\t");
	});

	it("stays hidden when goal mode is not active", () => {
		const rendered = renderSegment("goal", createContext({ goalState: createGoalState("Ship auth hardening") }));
		expect(rendered.visible).toBe(false);
	});
});
