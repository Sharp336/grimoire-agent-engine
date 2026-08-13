import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const PHONE_WIDTH = 36;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
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

type NamedModel = {
	name: string;
	id?: string;
	provider?: string;
	thinking?: boolean;
	thinkingLevel?: ThinkingLevel;
	maxLength?: number;
};

function createNamedModelContext(model: NamedModel): SegmentContext {
	return {
		...createModelContext(false),
		options: model.maxLength !== undefined ? { model: { maxLength: model.maxLength } } : {},
		session: {
			state: {
				model: {
					id: model.id ?? model.name,
					name: model.name,
					provider: model.provider,
					thinking: model.thinking ?? false,
				},
				thinkingLevel: model.thinkingLevel ?? ThinkingLevel.Off,
			},
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => false,
			getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		} as unknown as SegmentContext["session"],
	};
}

function visibleModelName(ctx: SegmentContext): string {
	let text = Bun.stripANSI(renderSegment("model", ctx).content);
	const icon = theme.icon.model;
	if (icon && text.startsWith(`${icon} `)) text = text.slice(icon.length + 1);
	const idx = text.indexOf(theme.sep.dot);
	if (idx !== -1) text = text.slice(0, idx);
	return text.trim();
}

function makeLayoutSession(model: {
	name: string;
	id: string;
	provider: string;
	thinking?: boolean;
}): ConstructorParameters<typeof StatusLineComponent>[0] {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-model-label-"));
	setProjectDir(tmp);
	const sessionModel = {
		name: model.name,
		id: model.id,
		provider: model.provider,
		contextWindow: 200000,
		thinking: model.thinking ?? true,
	};
	return {
		messages: [],
		model: sessionModel,
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
		sessionId: "model-label",
		modelRegistry: { isUsingOAuth: () => false, authStorage: { getOAuthAccountIdentity: () => undefined } },
		getContextUsage: () => ({ tokens: 50000, contextWindow: 200000 }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		sessionManager: {
			getSessionName: () => "model-label",
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
			model: sessionModel,
			thinkingLevel: "high",
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

const SMART_MODEL_CASES: Array<{
	label: string;
	model: NamedModel;
	mustInclude: readonly string[];
}> = [
	{
		label: "OpenAI Codex GPT-5.6 Sol",
		model: {
			name: "GPT-5.6 Sol",
			id: "gpt-5.6-sol",
			provider: "openai-codex",
			thinking: true,
			thinkingLevel: ThinkingLevel.High,
		},
		mustInclude: ["OC", "5.6", "Sol"],
	},
	{
		label: "GPT-5.6 Terra sibling",
		model: { name: "GPT-5.6 Terra", id: "gpt-5.6-terra", provider: "openai-codex" },
		mustInclude: ["OC", "5.6", "Terra"],
	},
	{
		label: "Claude Sonnet 5",
		model: { name: "Claude Sonnet 5", id: "claude-sonnet-5", provider: "anthropic" },
		mustInclude: ["A", "Sonnet", "5"],
	},
	{
		label: "Muse Spark 1.2 Contributor",
		model: {
			name: "Muse Spark 1.2 Contributor",
			id: "muse-spark-1.2-contributor",
			provider: "meta",
		},
		mustInclude: ["Spark", "1.2", "C"],
	},
	{
		label: "long unknown future model",
		model: {
			name: "Hyperion Quantum 12.3 Nebula Extended Edition",
			id: "hyperion-quantum-12.3-nebula-extended-edition",
			provider: "acme-labs",
		},
		mustInclude: ["12.3"],
	},
];

describe("status line model segment smart identity", () => {
	it.each(SMART_MODEL_CASES)(
		"$label keeps provider/version/qualifier instead of mid-token truncation",
		({ model, mustInclude }) => {
			const label = visibleModelName(createNamedModelContext(model));
			expect(label).not.toContain("…");
			expect(label).not.toMatch(/\d+\.$/);
			for (const piece of mustInclude) {
				expect(label).toContain(piece);
			}
		},
	);

	it("drops a duplicated provider word before touching version identity", () => {
		const label = visibleModelName(
			createNamedModelContext({
				name: "Cursor Grok 4.5",
				id: "cursor-grok-4.5-high",
				provider: "cursor",
			}),
		);
		expect(label).toContain("Grok");
		expect(label).toContain("4.5");
		expect(label).not.toMatch(/Cursor/i);
		expect(label).not.toContain("…");
	});

	it("keeps Gemini 3.6 Flash distinguishable under the default name cap", () => {
		const label = visibleModelName(
			createNamedModelContext({
				name: "Gemini 3.6 Flash",
				id: "gemini-3.6-flash",
				provider: "google-antigravity",
			}),
		);
		expect(label).toContain("3.6");
		expect(label).not.toContain("…");
		expect(label.includes("Flash") || label.includes("Gem") || label.includes("AG")).toBe(true);
	});
});

describe("default-preset model identity at phone/tmux width", () => {
	it.each(SMART_MODEL_CASES)("$label stays identifiable at 36 cols without overflowing", ({ model, mustInclude }) => {
		const component = new StatusLineComponent(
			makeLayoutSession({
				name: model.name,
				id: model.id ?? model.name,
				provider: model.provider ?? "openai-codex",
				thinking: true,
			}),
		);
		const rows = component.getTopBorderRows(PHONE_WIDTH);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.length).toBeLessThanOrEqual(2);
		const combined = rows.map(row => stripVTControlCharacters(row.content)).join(" ");
		expect(combined).not.toContain("…");
		for (const piece of mustInclude) {
			expect(combined).toContain(piece);
		}
		for (const row of rows) {
			expect(row.width).toBeLessThanOrEqual(PHONE_WIDTH);
			expect(visibleWidth(row.content)).toBeLessThanOrEqual(PHONE_WIDTH);
		}
		component.dispose();
	});

	it("degrades without overflow when the compact identity cannot fully fit", () => {
		const component = new StatusLineComponent(
			makeLayoutSession({
				name: "Hyperion Quantum 12.3 Nebula Extended Edition",
				id: "hyperion-quantum-12.3-nebula-extended-edition",
				provider: "acme-labs",
				thinking: true,
			}),
		);
		const width = 20;
		const rows = component.getTopBorderRows(width);
		const combined = rows.map(row => stripVTControlCharacters(row.content)).join(" ");
		expect(combined).toContain("12.3");
		expect(combined).not.toMatch(/12\.$/);
		for (const row of rows) {
			expect(row.width).toBeLessThanOrEqual(width);
			expect(visibleWidth(row.content)).toBeLessThanOrEqual(width);
		}
		component.dispose();
	});
});
