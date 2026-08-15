/**
 * `time_spent` shows elapsed wall-clock for the current top-level agent turn.
 *
 * Contract:
 * - Hidden before the first second so the bar does not flash `0s`.
 * - Starts at the current `agent_start` window and resets on the next turn;
 *   idle time between completed turns does not inflate the metric.
 * - Continues advancing while the parent is waiting on background jobs
 *   (`agent_end` with `isTerminal: false` does not close the window).
 * - Session-file switches (`/resume`, etc.) do not inherit another
 *   conversation's timer.
 * - Default-preset two-row layout keeps the metric visible at phone/tmux
 *   widths; wrap-priority clipping must not drop it behind cache/cost clutter.
 *   tok/s (`token_rate`) is dropped first on zoom.
 * - A ~1 Hz tick handler is started while the window is open and cleared on
 *   dispose so the displayed value can advance without leaking timers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const PHONE_WIDTHS = [36, 48, 60] as const;
const TWELVE_MIN_THIRTY_FOUR_MS = 12 * 60_000 + 34_000;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	setProjectDir(originalProjectDir);
});

function createCtx(activeMs: number): SegmentContext {
	return {
		// The segment under test never touches `session`; stub it.
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
		activeMs,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

function makeSession(
	overrides: { isStreaming?: boolean; sessionFile?: string | undefined; runningJobs?: number } = {},
): ConstructorParameters<typeof StatusLineComponent>[0] {
	// The component reads the session for usage stats, model, the
	// `isStreaming` gate inside `#closeStaleActiveWindow`, and the
	// `sessionFile` snapshot inside `#meter()` (file-change detection).
	// The time-spent accounting path otherwise never touches it — stub
	// with the minimum surface the constructor needs to settle.
	const running = Array.from({ length: overrides.runningJobs ?? 0 }, (_, i) => ({ id: `job-${i}` }));
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
		getAsyncJobSnapshot: () => ({ running }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionFile: overrides.sessionFile,
		sessionManager: {
			getSessionName: () => "time-spent test",
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

function makeRenderSession(): ConstructorParameters<typeof StatusLineComponent>[0] {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-elapsed-"));
	setProjectDir(tmp);
	const model = {
		name: "gpt-5.6-sol",
		id: "gpt-5.6-sol",
		provider: "openai-codex",
		contextWindow: 200000,
		thinking: true,
	};
	return {
		messages: [],
		model,
		contextUsageRevision: 0,
		systemPrompt: "system",
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: true,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getCurrentModel: () => undefined,
		sessionFile: path.join(tmp, "session.json"),
		sessionId: "elapsed-session",
		modelRegistry: { isUsingOAuth: () => false, authStorage: { getOAuthAccountIdentity: () => undefined } },
		getContextUsage: () => ({ tokens: 50000, contextWindow: 200000 }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		sessionManager: {
			getSessionName: () => "elapsed-session",
			getUsageStatistics: () => ({
				input: 1000,
				output: 500,
				cacheRead: 200,
				cacheWrite: 100,
				totalTokens: 1500,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0.12,
			}),
			getSessionDir: () => tmp,
		},
		state: {
			messages: [{ role: "assistant", timestamp: Date.now(), blocks: [] }],
			model,
			thinkingLevel: "high",
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function renderedStatusText(component: StatusLineComponent, width: number): string {
	return component
		.getTopBorderRows(width)
		.map(row => stripVTControlCharacters(row.content))
		.join(" ");
}

describe("time_spent segment", () => {
	it("renders active processing time and ignores wall-clock", () => {
		const rendered = renderSegment("time_spent", createCtx(10_000));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("10");
		expect(rendered.content).toContain("s");
	});

	it("hides under one second of activity so the segment does not flash 0s at session start", () => {
		expect(renderSegment("time_spent", createCtx(0)).visible).toBe(false);
		expect(renderSegment("time_spent", createCtx(999)).visible).toBe(false);
		expect(renderSegment("time_spent", createCtx(1000)).visible).toBe(true);
	});

	it("scales beyond seconds: formatDuration produces minute/hour suffixes", () => {
		const fiveMin = renderSegment("time_spent", createCtx(5 * 60_000));
		expect(fiveMin.content).toContain("5m");
		const twoHours = renderSegment("time_spent", createCtx(2 * 3_600_000));
		expect(twoHours.content).toContain("2h");
	});
});

describe("StatusLineComponent active-time accounting", () => {
	it("counts only the current open turn, not idle time or previous turns", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 1_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Idle: nothing accrues even as wall-clock advances.
		now += 10_000;
		expect(c.getActiveMs()).toBe(0);

		// First turn: 3s.
		now += 10_000;
		c.markActivityStart();
		now += 3_000;
		expect(c.getActiveMs()).toBe(3_000);
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);

		// Long idle gap (5 minutes) — elapsed stays at 0, not 3s + 5m.
		now += 300_000;
		expect(c.getActiveMs()).toBe(0);

		// Second turn starts fresh from zero, not the previous turn's 3s.
		c.markActivityStart();
		now += 2_000;
		expect(c.getActiveMs()).toBe(2_000);
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);
	});

	it("ticks live during an open window so the segment animates while the agent runs", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 2_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 1_500;
		expect(c.getActiveMs()).toBe(1_500);
		now += 2_700;
		expect(c.getActiveMs()).toBe(4_200);
	});

	it("is idempotent: reentrant markActivityStart and unmatched markActivityEnd never double-count", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 3_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Unmatched end while idle is a no-op.
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);

		c.markActivityStart();
		// A second start while already running must not reset the anchor.
		now += 5_000;
		c.markActivityStart();
		now += 2_000;
		expect(c.getActiveMs()).toBe(7_000);
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);

		// Closing again is a no-op.
		now += 92_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);
	});

	it("resetActiveTime resets the active accumulator for /clear and fresh-session flows", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 4_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 10_000;
		expect(c.getActiveMs()).toBe(10_000);

		c.resetActiveTime();
		expect(c.getActiveMs()).toBe(0);

		// Starting after reset begins from zero, not the prior total.
		now += 2_000;
		c.markActivityStart();
		now += 1_500;
		expect(c.getActiveMs()).toBe(1_500);
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);
	});

	it("resetActiveTime also drops an in-flight window so /clear during a turn starts fresh", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 5_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 4_000;
		expect(c.getActiveMs()).toBe(4_000);

		c.resetActiveTime();
		expect(c.getActiveMs()).toBe(0);

		// A stale markActivityEnd after the reset must not re-credit the dropped window.
		now += 5_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);
	});

	it("tracks meters per session: subagent agent_start opened while focused never ticks into the main meter on detach", () => {
		// Regression for the PR review: SessionFocusController synthesizes
		// `agent_start` on mid-turn attach but unfocusing immediately
		// unsubscribes without a matching synthetic `agent_end`. With a
		// single shared meter the main status line kept ticking through
		// idle time after the subagent later finished. Per-session WeakMap
		// keeps the leak inside the subagent's meter.
		const main = makeSession({ isStreaming: false });
		const sub = makeSession({ isStreaming: true });
		const c = new StatusLineComponent(main);
		let now = 6_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// 1s of main activity, closed cleanly.
		c.markActivityStart();
		now += 1_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);

		// Focus into a streaming subagent: synthesized agent_start opens
		// the subagent's meter only.
		c.setSession(sub, "Subagent");
		c.markActivityStart();
		now += 3_000;
		expect(c.getActiveMs()).toBe(3_000);

		// Detach back to main while subagent is still running — the
		// subagent meter stays open but the main meter is untouched.
		c.setSession(main);
		expect(c.getActiveMs()).toBe(0);
		// Wall-clock keeps advancing; main meter must not tick.
		now += 60_000;
		expect(c.getActiveMs()).toBe(0);
	});

	it("drops a stale subagent window on re-focus when the agent finished while we were detached", () => {
		// SessionFocusController only synthesizes agent_start when the
		// session is currently streaming. Re-focusing a now-idle session
		// whose previous meter is still open would otherwise tick over
		// the entire detached gap; the setSession close-stale path drops
		// it instead.
		const main = makeSession({ isStreaming: false });
		const sub = makeSession({ isStreaming: true });
		const c = new StatusLineComponent(main);
		let now = 7_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.setSession(sub, "Subagent");
		c.markActivityStart();
		now += 2_000;
		// Detach mid-turn — subagent meter left open.
		c.setSession(main);

		// Long detached gap. The subagent finishes in reality during this
		// gap, but we never see its agent_end because we're unsubscribed.
		now += 600_000;

		// Re-focus the (now idle) subagent. The stale window is dropped
		// rather than crediting the detached gap.
		(sub as unknown as { isStreaming: boolean }).isStreaming = false;
		c.setSession(sub, "Subagent");
		expect(c.getActiveMs()).toBe(0);
	});

	it("resets the meter when AgentSession.switchSession swaps the loaded session file under the same ref", () => {
		// Regression for the PR review: /resume, /move, ACP fork/load,
		// RPC switch_session, and extension switchSession all mutate
		// `sessionManager`'s loaded file in place under the same
		// AgentSession ref, so a WeakMap keyed only on the session ref
		// would carry the previous conversation's meter into the
		// resumed one.
		const session = makeSession({ sessionFile: "/tmp/conv-a.jsonl" });
		const c = new StatusLineComponent(session);
		let now = 8_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 30_000;
		expect(c.getActiveMs()).toBe(30_000);
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);

		// Simulate `session.switchSession("/tmp/conv-b.jsonl")` mutating
		// the file in place. The next meter read sees a real-to-real
		// transition and starts fresh.
		(session as unknown as { sessionFile: string }).sessionFile = "/tmp/conv-b.jsonl";
		expect(c.getActiveMs()).toBe(0);

		// Activity in the resumed conversation accrues from zero, not
		// from the previous conversation's 30s.
		c.markActivityStart();
		now += 2_000;
		expect(c.getActiveMs()).toBe(2_000);
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);
	});

	it("does not reset the meter on a first-save transition (sessionFile undefined → real)", () => {
		// A brand-new session starts without a loaded file path; the
		// first autosave sets one. That transition is the same
		// conversation, so the in-flight turn MUST survive.
		const session = makeSession({ sessionFile: undefined });
		const c = new StatusLineComponent(session);
		let now = 9_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 5_000;
		expect(c.getActiveMs()).toBe(5_000);

		// First save assigns a session file path. Same conversation —
		// the open window must NOT reset.
		(session as unknown as { sessionFile: string }).sessionFile = "/tmp/new-session.jsonl";
		expect(c.getActiveMs()).toBe(5_000);
	});

	it("keeps advancing while the top-level turn is waiting on a background job", () => {
		const c = new StatusLineComponent(makeSession({ runningJobs: 1 }));
		let now = 10_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 4_000;
		expect(c.getActiveMs()).toBe(4_000);
		// Parent has settled the LLM stream but left the activity window
		// open (`agent_end` with isTerminal: false). Elapsed must keep
		// climbing for the still-running job.
		now += 11_000;
		expect(c.getActiveMs()).toBe(15_000);
	});
});

describe("default-preset elapsed metric visibility", () => {
	it("keeps the current-turn elapsed metric visible at phone/tmux widths", () => {
		const c = new StatusLineComponent(makeRenderSession());
		let now = 11_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		c.markActivityStart();
		now += TWELVE_MIN_THIRTY_FOUR_MS;

		const expected = formatDuration(TWELVE_MIN_THIRTY_FOUR_MS);
		for (const width of PHONE_WIDTHS) {
			const text = renderedStatusText(c, width);
			expect(text).toContain(expected);
		}
	});

	it("advances the rendered elapsed text while top-level work stays active", () => {
		const c = new StatusLineComponent(makeRenderSession());
		let now = 12_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		c.markActivityStart();

		now += 12_000;
		expect(renderedStatusText(c, 48)).toContain(formatDuration(12_000));

		now += 3_000;
		const later = renderedStatusText(c, 48);
		expect(later).toContain(formatDuration(15_000));
		expect(later).not.toContain(formatDuration(12_000));
	});

	it("does not keep showing a prior turn's elapsed time after the turn ends", () => {
		const c = new StatusLineComponent(makeRenderSession());
		let now = 13_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		c.markActivityStart();
		now += 12_000;
		expect(renderedStatusText(c, 80)).toContain(formatDuration(12_000));

		c.markActivityEnd();
		now += 60_000;
		expect(renderedStatusText(c, 80)).not.toContain(formatDuration(12_000));
		expect(renderedStatusText(c, 80)).not.toContain(formatDuration(72_000));
	});

	it("drops tok/s at zoomed phone/tmux widths so elapsed time stays", () => {
		const c = new StatusLineComponent(makeRenderSession());
		c.setVibeWorkerTokenRateProvider(() => 42.5);
		let now = 14_500_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		c.markActivityStart();
		now += TWELVE_MIN_THIRTY_FOUR_MS;

		const expected = formatDuration(TWELVE_MIN_THIRTY_FOUR_MS);
		for (const width of [36, 48, 60, 80] as const) {
			const text = renderedStatusText(c, width);
			expect(text).toContain(expected);
			expect(text).not.toContain("tok/s");
			expect(text).not.toContain("42.5");
		}

		const wide = renderedStatusText(c, 240);
		expect(wide).toContain("tok/s");
		expect(wide).toContain("42.5");
		c.dispose();
	});

	it("stays within terminal width with intact separators at clipping-boundary widths", () => {
		const c = new StatusLineComponent(makeRenderSession());
		let now = 14_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		c.markActivityStart();
		now += TWELVE_MIN_THIRTY_FOUR_MS;

		const expected = formatDuration(TWELVE_MIN_THIRTY_FOUR_MS);
		for (const width of [36, 40, 48, 60, 80] as const) {
			const rows = c.getTopBorderRows(width);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.length).toBeLessThanOrEqual(3);
			for (const row of rows) {
				expect(row.width).toBeLessThanOrEqual(width);
				expect(visibleWidth(row.content)).toBeLessThanOrEqual(width);
				expect(row.content.includes("\x1b[")).toBe(true);
				const stripped = stripVTControlCharacters(row.content);
				expect(stripped.includes("\x1b")).toBe(false);
			}
			expect(rows.map(row => stripVTControlCharacters(row.content)).join(" ")).toContain(expected);
		}
	});
});

describe("time_spent activity tick teardown", () => {
	it("starts a 1Hz tick while a turn is open and clears it on dispose", () => {
		vi.useFakeTimers();
		const onTick = vi.fn();
		const c = new StatusLineComponent(makeSession());
		c.watchActivityTick(onTick);
		c.markActivityStart();

		expect(onTick).not.toHaveBeenCalled();
		vi.advanceTimersByTime(999);
		expect(onTick).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onTick).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		expect(onTick).toHaveBeenCalledTimes(2);

		c.markActivityEnd();
		onTick.mockClear();
		vi.advanceTimersByTime(3000);
		expect(onTick).not.toHaveBeenCalled();

		c.markActivityStart();
		vi.advanceTimersByTime(1000);
		expect(onTick).toHaveBeenCalledTimes(1);
		c.dispose();
		onTick.mockClear();
		vi.advanceTimersByTime(5000);
		expect(onTick).not.toHaveBeenCalled();
	});
});
