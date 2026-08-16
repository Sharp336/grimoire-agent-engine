import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

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

function makeSession(extensionRunner?: { getStatusLineSegment: (id: string) => unknown }) {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		extensionRunner,
		sessionManager: {
			getSessionName: () => "extension segments test",
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

describe("statusLine.enabled", () => {
	it("renders nothing when disabled", () => {
		const component = new StatusLineComponent(makeSession());
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			enabled: false,
		});

		const border = component.getTopBorder(80);
		expect(border.content).toBe("");
		expect(border.width).toBe(0);
	});

	it("renders normally when enabled (the default)", () => {
		const component = new StatusLineComponent(makeSession());
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
		});

		const border = component.getTopBorder(80);
		expect(border.content.length).toBeGreaterThan(0);
	});
});

describe("extension-registered status line segments", () => {
	it("renders an extension-registered segment id", () => {
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "my_widget" ? () => ({ content: "MY-WIDGET", visible: true }) : undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["my_widget"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		expect(component.getTopBorder(80).content).toContain("MY-WIDGET");
	});

	it("omits an unregistered segment id without throwing", () => {
		const component = new StatusLineComponent(makeSession());
		component.updateSettings({
			preset: "custom",
			leftSegments: ["not_a_real_segment"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		expect(() => component.getTopBorder(80)).not.toThrow();
	});

	it("does not consult the extension registry for a built-in id", () => {
		let calledWith: string | undefined;
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id => {
					calledWith = id;
					return () => ({ content: "SHOULD-NOT-APPEAR", visible: true });
				},
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const content = component.getTopBorder(80).content;
		expect(content).not.toContain("SHOULD-NOT-APPEAR");
		expect(calledWith).toBeUndefined();
	});

	it("treats a throwing extension segment as invisible instead of crashing the status line", () => {
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "broken_widget"
						? () => {
								throw new Error("boom");
							}
						: undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["broken_widget", "pi"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		expect(() => component.getTopBorder(80)).not.toThrow();
	});
});
