import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { Chalk } from "@oh-my-pi/pi-utils/chalk";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

function makeSession(): ConstructorParameters<typeof StatusLineComponent>[0] {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-two-row-"));
	setProjectDir(tmp);
	const session = {
		messages: [],
		model: { name: "test-model", provider: "anthropic", contextWindow: 200000 },
		contextUsageRevision: 0,
		systemPrompt: "system",
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getCurrentModel: () => undefined,
		sessionFile: path.join(tmp, "session.json"),
		sessionId: "test-session",
		modelRegistry: { isUsingOAuth: () => false, authStorage: { getOAuthAccountIdentity: () => undefined } },
		getContextUsage: () => ({ tokens: 50000, contextWindow: 200000 }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		sessionManager: {
			getSessionName: () => "test-session",
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
			model: { name: "test-model", provider: "anthropic", contextWindow: 200000 },
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
	return session;
}

function stripAnsi(s: string): string {
	return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\]8;;.*?\x07/g, "");
}

// Contract: the status area stays one row when it fits, wraps to a second physical row when needed,
// and never grows beyond two rows. Narrow layouts retain the highest-value operational metrics.

describe("status area wraps up to two physical rows", () => {
	it("at 240 cols stays on one physical status row when all visible segments fit", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		expect(typeof comp.getTopBorderRows).toBe("function");
		const rows = comp.getTopBorderRows(240);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBe(1);
		expect(rows[0]?.width).toBe(visibleWidth(rows[0]?.content ?? ""));
		expect(rows[0]?.width).toBeLessThanOrEqual(240);
	});

	it("at 60 cols still proves exactly two physical status rows", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		const rows = comp.getTopBorderRows(60);
		expect(rows.length).toBe(2);
		for (const r of rows) {
			expect(r.width).toBeLessThanOrEqual(60);
		}
	});

	it("at 36 cols (mobile) context remains visible somewhere in two rows", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		const rows = comp.getTopBorderRows(36);
		expect(rows.length).toBe(2);
		const combined = rows.map(r => stripAnsi((r as { content: string }).content)).join(" ");
		// Context uses concrete tokens; cache hit remains a percentage rate.
		expect(combined).toContain("50K/200K");
		expect((combined.match(/%/g) ?? []).length).toBeGreaterThanOrEqual(1);
	});

	it("editor renders two status rows above input (integration)", () => {
		const chalk = new Chalk({ level: 3 });
		const minimalTheme = {
			borderColor: (s: string) => chalk.dim(s),
			symbols: {
				boxRound: {
					topLeft: "+",
					topRight: "+",
					bottomLeft: "+",
					bottomRight: "+",
					horizontal: "-",
					vertical: "|",
				},
				boxSharp: {
					topLeft: "+",
					topRight: "+",
					bottomLeft: "+",
					bottomRight: "+",
					horizontal: "-",
					vertical: "|",
					teeDown: "+",
					teeUp: "+",
					teeLeft: "+",
					teeRight: "+",
					cross: "+",
				},
				table: {
					topLeft: "+",
					topRight: "+",
					bottomLeft: "+",
					bottomRight: "+",
					horizontal: "-",
					vertical: "|",
					teeDown: "+",
					teeUp: "+",
					teeLeft: "+",
					teeRight: "+",
					cross: "+",
				},
				quoteBorder: "│",
				hrChar: "-",
				spinnerFrames: ["-", "\\", "|", "/"],
			},
			selectList: {
				selectedPrefix: (s: string) => s,
				selectedText: (s: string) => s,
				description: (s: string) => s,
				scrollInfo: (s: string) => s,
				noMatch: (s: string) => s,
				symbols: {
					boxRound: {
						topLeft: "+",
						topRight: "+",
						bottomLeft: "+",
						bottomRight: "+",
						horizontal: "-",
						vertical: "|",
					},
					boxSharp: {
						topLeft: "+",
						topRight: "+",
						bottomLeft: "+",
						bottomRight: "+",
						horizontal: "-",
						vertical: "|",
						teeDown: "+",
						teeUp: "+",
						teeLeft: "+",
						teeRight: "+",
						cross: "+",
					},
					table: {
						topLeft: "+",
						topRight: "+",
						bottomLeft: "+",
						bottomRight: "+",
						horizontal: "-",
						vertical: "|",
						teeDown: "+",
						teeUp: "+",
						teeLeft: "+",
						teeRight: "+",
						cross: "+",
					},
					quoteBorder: "│",
					hrChar: "-",
					spinnerFrames: ["-", "\\", "|", "/"],
				},
			},
		} as unknown as ConstructorParameters<typeof Editor>[0];
		const editor = new Editor(minimalTheme);
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		// Editor must accept array provider
		let providerCalls = 0;
		editor.setTopBorderProvider(((w: number) => {
			providerCalls++;
			return comp.getTopBorderRows(w);
		}) as unknown as Parameters<typeof editor.setTopBorderProvider>[0]);
		const lines = editor.render(60);
		// Editor render should include 2 status rows + at least 1 content line + bottom border
		// So status rows are first 2 lines, distinctly not collapsed
		expect(providerCalls).toBeGreaterThan(0);
		expect(lines.length).toBeGreaterThanOrEqual(3);
		// First two lines are the status rows (top border area)
		const top1 = stripAnsi(lines[0] ?? "");
		const top2 = stripAnsi(lines[1] ?? "");
		expect(top1.length).toBeGreaterThan(0);
		expect(top2.length).toBeGreaterThan(0);
		expect(top1).not.toBe(top2);
		// Continuation status rows use tee junctions, not hanging vertical bars,
		// so the two-row header reads as one structured frame above the prompt.
		expect(top2.startsWith("+")).toBe(true);
		expect(top2.endsWith("+")).toBe(true);
		// Verify visible width accounting
		for (const line of [lines[0]!, lines[1]!]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});
});
