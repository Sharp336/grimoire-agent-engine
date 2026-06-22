import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { aggregateFastContext, taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/render";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { FastContextToolDetails } from "@oh-my-pi/pi-coding-agent/tools/fast-context";

function fcCall(overrides: Partial<FastContextToolDetails> = {}): FastContextToolDetails {
	return {
		model: "devin/swe-1-6-fast",
		mode: "hint",
		turns: 1,
		citations: ["code/Auth.ts:1-10", "code/Login.ts:5-20"],
		...overrides,
	};
}

function rendered(
	details: TaskToolDetails,
	theme: Theme,
	isPartial: boolean,
): string {
	const options: RenderResultOptions = { expanded: true, isPartial, spinnerFrame: 0 };
	const component = taskToolRenderer.renderResult(
		{ content: [{ type: "text", text: isPartial ? "running" : "done" }], details },
		options,
		theme,
	);
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("FastContext badge on task cards", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("shows the badge on a finished subagent that used fast_context (rebuilt path)", async () => {
		const theme = (await getThemeByName("dark"))!;
		const result: SingleResult = {
			index: 0,
			id: "Scout",
			agent: "explore",
			agentSource: "bundled",
			task: "find auth",
			exitCode: 0,
			output: "found auth",
			stderr: "",
			truncated: false,
			durationMs: 1600,
			tokens: 73,
			requests: 1,
			extractedToolData: { fast_context: [fcCall()] },
		};
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: 1600,
		};

		const out = rendered(details, theme, false);

		expect(out).toContain("fast_context");
		expect(out).toContain("devin/swe-1-6-fast");
		expect(out).toContain("1 call");
		expect(out).toContain("2 files");
	});

	it("shows the badge live while the subagent is still running (live path)", async () => {
		const theme = (await getThemeByName("dark"))!;
		const progress: AgentProgress = {
			index: 0,
			id: "Scout",
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: "find auth",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 73,
			cost: 0,
			durationMs: 1200,
			extractedToolData: { fast_context: [fcCall()] },
		};
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress],
		};

		const out = rendered(details, theme, true);

		expect(out).toContain("fast_context");
		expect(out).toContain("devin/swe-1-6-fast");
	});

	it("does not show a badge when the subagent did not use fast_context", async () => {
		const theme = (await getThemeByName("dark"))!;
		const result: SingleResult = {
			index: 0,
			id: "Scout",
			agent: "explore",
			agentSource: "bundled",
			task: "find auth",
			exitCode: 0,
			output: "found auth",
			stderr: "",
			truncated: false,
			durationMs: 1600,
			tokens: 73,
			requests: 1,
			extractedToolData: {},
		};
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: 1600,
		};

		const out = rendered(details, theme, false);

		expect(out).not.toContain("fast_context");
	});
});

describe("aggregateFastContext", () => {
	it("sums citations across calls, counts calls, and keeps the last model", () => {
		const summary = aggregateFastContext([
			fcCall(),
			fcCall({ citations: ["code/X.ts:1-1"], model: "devin/swe-1-6-slow" }),
		]);
		expect(summary).toEqual({
			used: true,
			model: "devin/swe-1-6-slow",
			calls: 2,
			files: 3,
		});
	});

	it("returns undefined when there are no calls (common path stays untouched)", () => {
		expect(aggregateFastContext(undefined)).toBeUndefined();
		expect(aggregateFastContext([])).toBeUndefined();
	});
});
