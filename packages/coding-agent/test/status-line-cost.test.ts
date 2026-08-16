import { beforeAll, describe, expect, it } from "bun:test";
import { mergeSegmentOptions } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/presets";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createCostContext(oauth: boolean, costOptions: SegmentContext["options"]["cost"]): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			modelRegistry: { isUsingOAuth: () => oauth },
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: { cost: costOptions },
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
			cost: 1.23,
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

describe("status line cost segment subscription marker", () => {
	it("shows (sub) for OAuth-billed models by default", () => {
		const rendered = renderSegment("cost", createCostContext(true, undefined));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("(sub)");
		expect(rendered.content).toContain("$1.23");
	});

	it("hides (sub) when cost.showSubscription is false, keeping the dollar figure", () => {
		const rendered = renderSegment("cost", createCostContext(true, { showSubscription: false }));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).not.toContain("(sub)");
		expect(rendered.content).toContain("$1.23");
	});

	it("never shows (sub) for metered models, regardless of the option", () => {
		const rendered = renderSegment("cost", createCostContext(false, { showSubscription: false }));
		expect(rendered.content).not.toContain("(sub)");
		expect(rendered.content).toContain("$1.23");
	});

	it("collapses to invisible when a zero-spend OAuth session hides the marker", () => {
		const ctx = createCostContext(true, { showSubscription: false });
		ctx.usageStats = { ...ctx.usageStats, cost: 0 };
		const rendered = renderSegment("cost", ctx);
		expect(rendered.visible).toBe(false);
	});

	it("keeps the marker-only segment visible with the default option", () => {
		const ctx = createCostContext(true, undefined);
		ctx.usageStats = { ...ctx.usageStats, cost: 0 };
		const rendered = renderSegment("cost", ctx);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("(sub)");
	});
});

describe("mergeSegmentOptions", () => {
	it("merges user options over preset defaults per segment", () => {
		const merged = mergeSegmentOptions("default", { cost: { showSubscription: false } });
		expect(merged.cost?.showSubscription).toBe(false);
		// Preset defaults survive alongside user overrides.
		expect(merged.model?.showThinkingLevel).toBe(true);
		expect(merged.git?.showStaged).toBe(true);
	});

	it("applies preset defaults when the user sets nothing", () => {
		const merged = mergeSegmentOptions("minimal", undefined);
		expect(merged.git?.showStaged).toBe(false);
		expect(merged.path?.maxLength).toBe(30);
		expect(merged.cost).toBeUndefined();
	});

	it("merges per option key, not per segment bag", () => {
		const merged = mergeSegmentOptions("default", { git: { showStaged: false } });
		expect(merged.git?.showStaged).toBe(false);
		expect(merged.git?.showBranch).toBe(true);
		expect(merged.git?.showUnstaged).toBe(true);
	});
});
