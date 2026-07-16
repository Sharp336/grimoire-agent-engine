/**
 * Contract: vibe mode status-line segment keeps a persistent roster count so
 * background workers remain visible after the director goes idle.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createModeContext(vibeMode: SegmentContext["vibeMode"]): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => false,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode,
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
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line vibe mode segment", () => {
	it("renders Vibe alone when the roster is empty", () => {
		const rendered = renderSegment("mode", createModeContext({ enabled: true, total: 0, running: 0, idle: 0 }));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toContain("Vibe");
		expect(Bun.stripANSI(rendered.content)).not.toContain("run");
		expect(Bun.stripANSI(rendered.content)).not.toContain("idle");
	});

	it("shows running and idle worker counts while vibe mode is active", () => {
		const rendered = renderSegment(
			"mode",
			createModeContext({ enabled: true, total: 3, running: 2, idle: 1 }),
		);
		const text = Bun.stripANSI(rendered.content);
		expect(text).toContain("Vibe");
		expect(text).toContain("2 run");
		expect(text).toContain("1 idle");
	});
});
