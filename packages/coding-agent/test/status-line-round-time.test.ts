/**
 * `round_time` status segment: while the agent is processing it shows the
 * live elapsed time of the current round; while idle it shows the duration
 * of the most recently completed round.
 *
 * Contract:
 * - Running (`roundActiveStartedAt !== null`): renders live elapsed time,
 *   ticking as wall-clock advances.
 * - Idle with a completed round: renders `last <duration>`.
 * - Idle with no completed round yet / sub-second last round: hidden, so a
 *   fresh session does not flash `0s`.
 * - `StatusLineComponent` tracks `roundActiveStartedAt` (non-null while a
 *   window is open) and `lastRoundMs` (set on `markActivityEnd`);
 *   `resetActiveTime` clears both.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createCtx(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: {} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs: 0,
		roundActiveStartedAt: null,
		lastRoundMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

function makeSession(
	overrides: { isStreaming?: boolean; sessionFile?: string | undefined } = {},
): ConstructorParameters<typeof StatusLineComponent>[0] {
	// Minimum surface the constructor needs to settle; the round-time
	// accounting path otherwise never touches it.
	return {
		state: { messages: [], model: undefined },
		messages: [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: overrides.isStreaming ?? false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionFile: overrides.sessionFile,
		sessionManager: {
			getSessionName: () => "round-time test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

describe("round_time segment", () => {
	it("renders live elapsed time while the agent is running", () => {
		const base = Date.now() - 10_000;
		vi.spyOn(Date, "now").mockReturnValue(base + 10_000);
		const rendered = renderSegment("round_time", createCtx({ roundActiveStartedAt: base }));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("10");
		expect(rendered.content).toContain("s");
		// Live display has no "last" prefix.
		expect(rendered.content).not.toContain("last");
	});

	it("ticks as wall-clock advances during a running round", () => {
		const startedAt = 1_000_000_000_000;
		let now = startedAt;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const ctx = createCtx({ roundActiveStartedAt: startedAt });

		now += 2_000;
		expect(renderSegment("round_time", ctx).content).toContain("2");
		now += 5_000;
		expect(renderSegment("round_time", ctx).content).toContain("7");
	});

	it("renders `last <duration>` while idle after a completed round", () => {
		const rendered = renderSegment("round_time", createCtx({ lastRoundMs: 12_000 }));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("last");
		expect(rendered.content).toContain("12");
		expect(rendered.content).toContain("s");
	});

	it("hides on a fresh session with no completed round", () => {
		expect(renderSegment("round_time", createCtx()).visible).toBe(false);
	});

	it("hides a sub-second last round so the idle display does not flash 0s", () => {
		expect(renderSegment("round_time", createCtx({ lastRoundMs: 0 })).visible).toBe(false);
		expect(renderSegment("round_time", createCtx({ lastRoundMs: 999 })).visible).toBe(false);
		expect(renderSegment("round_time", createCtx({ lastRoundMs: 1000 })).visible).toBe(true);
	});
});

describe("StatusLineComponent round-time accounting", () => {
	it("tracks the open window while running and the last round once closed", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 1_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Fresh: no open window, no completed round.
		expect(c.getRoundTime()).toEqual({ roundActiveStartedAt: null, lastRoundMs: 0 });

		// Start a round; the window anchor is captured.
		c.markActivityStart();
		const during = c.getRoundTime();
		expect(during.roundActiveStartedAt).not.toBeNull();
		expect(during.lastRoundMs).toBe(0);

		// 3s of work, then close — lastRoundMs records exactly the round.
		now += 3_000;
		c.markActivityEnd();
		expect(c.getRoundTime()).toEqual({ roundActiveStartedAt: null, lastRoundMs: 3_000 });
	});

	it("lastRoundMs holds the most recent round, not the cumulative total", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 2_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 2_000;
		c.markActivityEnd();
		c.markActivityStart();
		now += 5_000;
		c.markActivityEnd();

		// activeMs is cumulative (7s) but lastRoundMs is the latest round (5s).
		expect(c.getActiveMs()).toBe(7_000);
		expect(c.getRoundTime().lastRoundMs).toBe(5_000);
	});

	it("resetActiveTime clears both the open window and lastRoundMs", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 3_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 4_000;
		c.markActivityEnd();
		expect(c.getRoundTime().lastRoundMs).toBe(4_000);

		c.resetActiveTime();
		expect(c.getRoundTime()).toEqual({ roundActiveStartedAt: null, lastRoundMs: 0 });
	});
});
