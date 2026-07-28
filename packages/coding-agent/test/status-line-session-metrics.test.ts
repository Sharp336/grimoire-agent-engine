import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { STATUS_LINE_PRESETS } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/presets";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const KILOBYTE = 1024;
const MEGABYTE = 1024 * KILOBYTE;

let settingsState: SettingsTestState | undefined;
let projectDir = "";

beforeEach(async () => {
	settingsState = beginSettingsTest();
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-session-metrics-"));
	setProjectDir(projectDir);
	await Settings.init({ inMemory: true, cwd: projectDir });
	await initTheme(false, "nerd", false, "titanium", "light");
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	if (projectDir) removeSyncWithRetries(projectDir);
	projectDir = "";
});

describe("session_metrics segment", () => {
	it("remains opt-in for every built-in preset", () => {
		for (const preset of Object.values(STATUS_LINE_PRESETS)) {
			expect(preset.leftSegments).not.toContain("session_metrics");
			expect(preset.rightSegments).not.toContain("session_metrics");
		}
	});

	it("renders the compaction count and binary KB/MB journal size in the native theme", () => {
		const cases: Array<[bytes: number, expected: string]> = [
			[0, " 3/0 KB 󰆓"],
			[1536, " 3/1.5 KB 󰆓"],
			[MEGABYTE, " 3/1 MB 󰆓"],
			[1.75 * MEGABYTE, " 3/1.8 MB 󰆓"],
		];

		for (const [bytes, expected] of cases) {
			const rendered = renderSegment("session_metrics", {
				sessionMetrics: { compactions: 3, bytes },
			} as SegmentContext);
			expect(rendered).toEqual({
				content: theme.fg("statusLineSessionMetrics", expected),
				visible: true,
			});
		}
	});

	it("refreshes the real journal after mutations even when the active leaf is unchanged", async () => {
		const sessionFile = path.join(projectDir, "session.jsonl");
		await Bun.write(sessionFile, "x".repeat(1536));

		let journalRevision = 1;
		let compactions = 2;
		let metricReads = 0;
		const session = {
			state: { messages: [], model: undefined },
			messages: [],
			systemPrompt: [],
			agent: { state: { tools: [] } },
			skills: [],
			isStreaming: false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isFastModeActive: () => false,
			getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			getAsyncJobSnapshot: () => ({ running: [] }),
			getGoalModeState: () => null,
			settings: { get: () => false },
			modelRegistry: { isUsingOAuth: () => false },
			sessionFile,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getJournalRevision: () => journalRevision,
				getCompactionCount: () => {
					metricReads++;
					return compactions;
				},
				getSessionName: () => undefined,
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

		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["session_metrics"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
		});

		const first = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(first).toContain(" 2/1.5 KB 󰆓");
		expect(metricReads).toBe(1);

		await Bun.write(sessionFile, "x".repeat(2 * MEGABYTE));
		const stale = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(stale).toContain(" 2/1.5 KB 󰆓");
		expect(metricReads).toBe(1);

		compactions = 3;
		journalRevision++;

		const second = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(second).toContain(" 3/2 MB 󰆓");
		expect(metricReads).toBe(2);
	});
});
