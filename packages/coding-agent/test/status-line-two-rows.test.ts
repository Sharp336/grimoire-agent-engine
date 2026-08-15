import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as SettingsSelectorModule from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as ThemeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
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

// Contract: the default preset is a three-row provider-aware footer. Custom
// presets still wrap into at most two packed rows.

describe("status area uses a three-row default footer", () => {
	it("at 240 cols keeps the default three-row provider-aware footer", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		expect(typeof comp.getTopBorderRows).toBe("function");
		const rows = comp.getTopBorderRows(240);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBe(3);
		expect(rows[0]?.width).toBe(visibleWidth(rows[0]?.content ?? ""));
		expect(rows[0]?.width).toBeLessThanOrEqual(240);
	});

	it("at 60 cols still fits three physical status rows", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		const rows = comp.getTopBorderRows(60);
		expect(rows.length).toBe(3);
		for (const r of rows) {
			expect(r.width).toBeLessThanOrEqual(60);
		}
	});

	it("at 36 cols (mobile) context remains visible in the default footer", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		const rows = comp.getTopBorderRows(36);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows.length).toBeLessThanOrEqual(3);
		const combined = rows.map(r => stripAnsi((r as { content: string }).content)).join(" ");
		// Context uses concrete tokens; cache hit remains a percentage rate.
		expect(combined).toContain("50K/200K");
		expect((combined.match(/%/g) ?? []).length).toBeGreaterThanOrEqual(1);
	});

	it("editor renders three status rows above input (integration)", () => {
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
		// Editor render should include 3 status rows + at least 1 content line + bottom border
		expect(providerCalls).toBeGreaterThan(0);
		expect(lines.length).toBeGreaterThanOrEqual(4);
		const top1 = stripAnsi(lines[0] ?? "");
		const top2 = stripAnsi(lines[1] ?? "");
		const top3 = stripAnsi(lines[2] ?? "");
		expect(top1.length).toBeGreaterThan(0);
		expect(top2.length).toBeGreaterThan(0);
		expect(top3.length).toBeGreaterThan(0);
		expect(top1).not.toBe(top2);
		// Continuation status rows use tee junctions, not hanging vertical bars.
		expect(top2.startsWith("+")).toBe(true);
		expect(top2.endsWith("+")).toBe(true);
		expect(top3.startsWith("+")).toBe(true);
		expect(top3.endsWith("+")).toBe(true);
		for (const line of [lines[0]!, lines[1]!, lines[2]!]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});
});
describe("Finding G: metrics split is gated on actual overflow", () => {
	it("sparse minimal at 100 cols renders ONE row when it fits", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		comp.updateSettings({ preset: "minimal", transparent: true, sessionAccent: false });
		const rows = comp.getTopBorderRows(100);
		expect(rows.length).toBe(1);
		comp.dispose();
	});

	it("still wraps when genuinely does not fit", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model", "mode", "path", "git"],
			rightSegments: ["session_name", "cost", "context_pct", "cache_hit", "token_total"],
			separator: "powerline-thin",
			transparent: true,
			sessionAccent: false,
		});
		const rows = comp.getTopBorderRows(40);
		expect(rows.length).toBeGreaterThan(1);
		for (const r of rows) expect(r.width).toBeLessThanOrEqual(40);
		comp.dispose();
	});
});

describe("Finding K: right-side alignment preserved when single row fits", () => {
	it("custom preset with right-side content keeps right alignment, mirrored separators and end caps", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model"],
			rightSegments: ["session_name", "cost", "context_pct"],
			separator: "powerline-thin",
			transparent: false,
			sessionAccent: true,
		});
		const width = 100;
		const rows = comp.getTopBorderRows(width);
		expect(rows.length).toBe(1);
		const content = rows[0]!.content;
		expect(content).toContain(theme.sep.powerlineThinRight);
		expect(content).toContain(theme.sep.powerlineThinLeft);
		expect(content).toContain(theme.sep.powerlineLeft);
		expect(content).toContain(theme.sep.powerlineRight);
		const plain = stripAnsi(content);
		expect(plain).toContain("─");
		expect(plain.indexOf("test-session")).toBeGreaterThan(plain.indexOf("─"));
		comp.dispose();
	});

	it("redistributes when wrapping genuinely required", () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model", "path"],
			rightSegments: ["session_name", "cost", "context_pct", "token_total", "cache_hit"],
			separator: "powerline-thin",
			transparent: true,
			sessionAccent: false,
		});
		const rows = comp.getTopBorderRows(50);
		expect(rows.length).toBeGreaterThan(1);
		comp.dispose();
	});
});

describe("Finding F: settings preview matches wrapped renderer", () => {
	it("at narrow width preview equals wrapped rows, not legacy single row", async () => {
		const session = makeSession();
		const comp = new StatusLineComponent(session);
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model", "mode", "path"],
			rightSegments: ["session_name", "cost", "context_pct", "token_total"],
			separator: "powerline-thin",
			transparent: true,
			sessionAccent: false,
		});
		const width = 60;
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
		const availableWidth = editor.getTopBorderAvailableWidth(width);
		const legacy = stripAnsi(comp.getTopBorder(availableWidth).content);
		const wrapped = comp
			.getTopBorderRows(availableWidth)
			.map(row => stripAnsi(row.content))
			.join("\n");
		expect(legacy).not.toEqual(wrapped);
		const ui = {
			terminal: { columns: width },
			showOverlay: vi.fn(() => ({ hide: vi.fn() })),
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			imageBudget: undefined,
		} as unknown as TUI;
		let capturedPreview: (() => string) | undefined;
		const spy = vi.spyOn(SettingsSelectorModule, "SettingsSelectorComponent").mockImplementation(((
			_ctx: unknown,
			callbacks: { getStatusLinePreview?: () => string },
		) => {
			capturedPreview = callbacks.getStatusLinePreview;
			return { render: () => [], handleInput: () => {}, invalidate: () => {} } as unknown as Component;
		}) as unknown as never);
		const themeSpy = vi.spyOn(ThemeModule, "getAvailableThemes").mockResolvedValue(["dark", "light"] as never);
		const ctx = {
			ui,
			editor,
			statusLine: comp,
			session: {
				...session,
				getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
				thinkingLevel: "off",
				getAvailableModels: () => [{ provider: "anthropic", id: "test-model", name: "test-model" }],
				model: { name: "test-model", provider: "anthropic", contextWindow: 200000 },
			} as unknown as InteractiveModeContext["session"],
			sessionManager: (session as unknown as { sessionManager: unknown })
				.sessionManager as unknown as SessionManager,
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		controller.showSettingsSelector();
		await Promise.resolve();
		await Promise.resolve();
		expect(capturedPreview).toBeDefined();
		const preview = stripAnsi(capturedPreview!());
		expect(preview).toEqual(wrapped);
		spy.mockRestore();
		themeSpy.mockRestore();
		comp.dispose();
	});
});
