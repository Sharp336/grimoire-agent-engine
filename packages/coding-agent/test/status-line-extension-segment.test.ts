import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line";
import { initTheme } from "../src/modes/theme/theme";

const originalProjectDir = getProjectDir();
let tmpDir: string;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-extension-segment-"));
	setProjectDir(tmpDir);
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

function createStatusLineSession(modelName = "core-model") {
	const model = { id: modelName, name: modelName, contextWindow: 200_000 };
	return {
		state: { messages: [], model },
		messages: [],
		model,
		systemPrompt: [],
		skills: [],
		agent: { state: { tools: [] } },
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => model,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => undefined,
		sessionManager: {
			getSessionName: () => "extension segment test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function buildComponent(modelName?: string): StatusLineComponent {
	const component = new StatusLineComponent(createStatusLineSession(modelName));
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: [],
		separator: "pipe",
		sessionAccent: false,
	});
	return component;
}

function plainTopBorder(component: StatusLineComponent, width = 120): string {
	return Bun.stripANSI(component.getTopBorder(width).content);
}

describe("status line extension segments", () => {
	it("renders left-side extension segment text in the top border", () => {
		const component = buildComponent();

		component.setExtensionSegment("profile", "◈ dev");

		expect(plainTopBorder(component)).toContain("◈ dev");
	});

	it("removes a segment when cleared", () => {
		const component = buildComponent();
		component.setExtensionSegment("profile", "◈ dev");

		component.setExtensionSegment("profile", undefined);

		expect(plainTopBorder(component)).not.toContain("◈ dev");
	});

	it("renders right-side extension segment text in the right group", () => {
		const component = buildComponent();

		component.setExtensionSegment("profile", "right-profile", "right");
		const plain = plainTopBorder(component, 80);

		expect(plain.indexOf("right-profile")).toBeGreaterThan(plain.indexOf("core-model"));
		expect(plain.trimEnd().endsWith("right-profile")).toBe(true);
	});

	it("drops extension segments before built-in left segments under overflow", () => {
		const component = buildComponent("core");
		const width = 20;

		component.setExtensionSegment("profile", "extremely-long-extension-segment");
		const border = component.getTopBorder(width);
		const plain = Bun.stripANSI(border.content);

		expect(visibleWidth(border.content)).toBeLessThanOrEqual(width);
		expect(plain).toContain("core");
		expect(plain).not.toContain("extremely-long-extension-segment");
	});

	it("drops a left extension before built-in right segments under overflow", () => {
		// Regression: a long left extension must not evict a built-in right
		// segment. Extension segments are shed before built-ins on either side.
		const component = new StatusLineComponent(createStatusLineSession("coremodel"));
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["model"],
			separator: "pipe",
			sessionAccent: false,
		});
		const width = 24;

		component.setExtensionSegment("profile", "extremely-long-extension-segment");
		const border = component.getTopBorder(width);
		const plain = Bun.stripANSI(border.content);

		expect(visibleWidth(border.content)).toBeLessThanOrEqual(width);
		expect(plain).toContain("coremodel");
		expect(plain).not.toContain("extremely-long-extension-segment");
	});

	it("renders multiple extension segment keys deterministically", () => {
		const component = buildComponent();

		component.setExtensionSegment("zeta", "Z segment");
		component.setExtensionSegment("alpha", "A segment");
		const plain = plainTopBorder(component);

		expect(plain.indexOf("A segment")).toBeLessThan(plain.indexOf("Z segment"));
	});

	it("orders extension segments by order then key", () => {
		const component = buildComponent();

		// alpha sorts before zeta by key, but order overrides: zeta(order 0) first.
		component.setExtensionSegment("alpha", "A segment", "left", 10);
		component.setExtensionSegment("zeta", "Z segment", "left", 0);
		const plain = plainTopBorder(component);

		expect(plain.indexOf("Z segment")).toBeLessThan(plain.indexOf("A segment"));
	});

	it("breaks order ties by key", () => {
		const component = buildComponent();

		component.setExtensionSegment("zeta", "Z segment", "left", 5);
		component.setExtensionSegment("alpha", "A segment", "left", 5);
		const plain = plainTopBorder(component);

		expect(plain.indexOf("A segment")).toBeLessThan(plain.indexOf("Z segment"));
	});
});
