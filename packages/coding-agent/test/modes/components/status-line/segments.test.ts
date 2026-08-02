import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

function createFocusedContext(focusedAgentId: string): SegmentContext {
	return {
		session: {
			state: {},
		} as unknown as SegmentContext["session"],
		focusedAgentId,
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
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line pi segment focused badge", () => {
	it("renders the focused ref displayName instead of the registry id", () => {
		AgentRegistry.global().register({
			id: "side.internal",
			displayName: "side",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "idle",
		});

		const content = Bun.stripANSI(renderSegment("pi", createFocusedContext("side.internal")).content);
		expect(content).toContain("side");
		expect(content).not.toContain("side.internal");
	});

	it("falls back to the focused id when the ref is unregistered", () => {
		const content = Bun.stripANSI(renderSegment("pi", createFocusedContext("side.internal")).content);
		expect(content).toContain("side.internal");
	});

	it("flattens control characters and bounds the focused display name", () => {
		AgentRegistry.global().register({
			id: "agent-1",
			displayName: `evil\tname\nwith\x1b[31mansi ${"x".repeat(200)}`,
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "idle",
		});

		const raw = renderSegment("pi", createFocusedContext("agent-1")).content;
		// The injected escape must not survive into the rendered label (before
		// any stripping — stripping here would make this assertion vacuous).
		expect(raw).not.toContain("\x1b[31m");
		const content = Bun.stripANSI(raw);
		expect(content).not.toContain("[31m");
		expect(content).not.toContain("\t");
		expect(content).not.toContain("\n");
		expect(content.length).toBeLessThan(120);
	});
});
