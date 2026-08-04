import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createModelContext(advisorActive: boolean): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => advisorActive,
			getAdvisorStatusOverview: () => ({
				configured: advisorActive,
				advisors: advisorActive ? [{ name: "default", status: "running" }] : [],
			}),
		} as unknown as SegmentContext["session"],
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

describe("status line model segment advisor badge", () => {
	it("appends a success-colored ++ badge when all advisors run", () => {
		const rendered = renderSegment("model", createModelContext(true));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).toContain(theme.fg("success", "++"));
	});

	it("colors the badge by the worst roster status", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running" },
				{ name: "b", status: "quota_exhausted" },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("warning", "++"));
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "error" },
				{ name: "b", status: "quota_exhausted" },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("error", "++"));
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).not.toContain("++");
	});
});

describe("status line model segment compact thinking level", () => {
	function createThinkingContext(compactThinkingLevel: boolean): SegmentContext {
		return {
			...createModelContext(false),
			compactThinkingLevel,
			session: {
				state: {
					model: { id: "test-model", name: "Test Model", thinking: true },
					thinkingLevel: ThinkingLevel.High,
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
	}

	it("trails the level as a ` · <level>` suffix when compact mode is off", () => {
		const display = theme.thinking.high;
		const modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
		const rendered = renderSegment("model", createThinkingContext(false));
		expect(Bun.stripANSI(rendered.content)).toBe(`${modelPrefix}Test Model${theme.sep.dot}${display}`);
	});

	it("swaps the model icon for the level glyph and drops the suffix when compact", () => {
		const display = theme.thinking.high;
		const glyph = display.includes(" ") ? display.slice(0, display.indexOf(" ")) : display;
		const rendered = renderSegment("model", createThinkingContext(true));
		expect(Bun.stripANSI(rendered.content)).toBe(`${glyph} Test Model`);
		expect(Bun.stripANSI(rendered.content)).not.toContain(theme.sep.dot);
	});
});

describe("status line model segment showProvider", () => {
	function createProviderContext(showProvider: boolean, provider: string): SegmentContext {
		return {
			...createModelContext(false),
			options: { model: { showProvider } },
			session: {
				state: {
					model: { id: "test-model", name: "Test Model", provider },
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
	}

	it("prepends capitalized provider prefix when showProvider is true", () => {
		const rendered = renderSegment("model", createProviderContext(true, "anthropic"));
		const stripped = Bun.stripANSI(rendered.content);
		expect(stripped).toContain("Anthropic/Test Model");
		// Slash separates provider from the model name, not from the icon.
		const icon = theme.icon.model ? `${theme.icon.model} ` : "";
		expect(stripped).toBe(`${icon}Anthropic/Test Model`);
		// Provider span is dim and does not wrap (nest inside) the model span:
		// icon and model keep their own statusLineModel spans, provider its own dim.
		const dimAnsi = theme.getFgAnsi("dim");
		const modelAnsi = theme.getFgAnsi("statusLineModel");
		const reset = "\x1b[39m";
		expect(rendered.content).toContain(
			`${modelAnsi}${icon}${reset}${dimAnsi}Anthropic/${reset}${modelAnsi}Test Model`,
		);
		expect(rendered.content).not.toContain(`${dimAnsi}Anthropic/${reset}${modelAnsi}${icon}`);
	});

	it("omits provider prefix when showProvider is false", () => {
		const rendered = renderSegment("model", createProviderContext(false, "anthropic"));
		expect(Bun.stripANSI(rendered.content)).not.toContain("Anthropic");
		expect(Bun.stripANSI(rendered.content)).toContain("Test Model");
	});

	it("omits provider prefix when showProvider is true but model has no provider", () => {
		const ctx = createProviderContext(true, "anthropic");
		ctx.session.state.model = { id: "test-model", name: "Test Model" } as SegmentContext["session"]["state"]["model"];
		const rendered = renderSegment("model", ctx);
		expect(Bun.stripANSI(rendered.content)).not.toContain("Anthropic");
	});

	it("omits provider prefix when options.model is absent", () => {
		const ctx = createModelContext(false);
		ctx.options = {};
		ctx.session.state.model = {
			id: "test-model",
			name: "Test Model",
			provider: "anthropic",
		} as SegmentContext["session"]["state"]["model"];
		const rendered = renderSegment("model", ctx);
		expect(Bun.stripANSI(rendered.content)).not.toContain("Anthropic");
	});
});
