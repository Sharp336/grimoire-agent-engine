import { beforeAll, describe, expect, test, vi } from "bun:test";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const cursorMaxModel: Model<"cursor-agent"> = {
	id: "gpt-5.5-extra-high",
	name: "GPT-5.5 Extra High",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 64_000,
	extendedContext: {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		baseContextWindow: 272_000,
		baseMaxTokens: 64_000,
	},
};

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

interface OnSelectCall {
	model: Model;
	role: string | null;
	thinkingLevel: string | undefined;
	selector: string | undefined;
	maxMode: boolean | undefined;
}

function createSelector(
	model: Model,
	settings: Settings,
	options?: { temporaryOnly?: boolean; initialSearchInput?: string },
): { selector: ModelSelectorComponent; calls: OnSelectCall[] } {
	const modelRegistry = {
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const calls: OnSelectCall[] = [];
	const selector = new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: "off" }],
		(model, role, choice) => {
			calls.push({
				model,
				role,
				thinkingLevel: choice.thinkingLevel,
				selector: choice.selector,
				maxMode: choice.maxMode,
			});
		},
		() => {},
		options,
	);
	return { selector, calls };
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load dark theme");
	setThemeInstance(testTheme);
}

describe("ModelSelector multi-step menu flow", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme");
	});

	test("Cursor MAX-capable model exposes step2 MAX choice and commits maxMode=true", async () => {
		installTestTheme();
		const settings = Settings.isolated({
			modelRoles: { default: `${cursorMaxModel.provider}/${cursorMaxModel.id}` },
		});
		const { selector, calls } = createSelector(cursorMaxModel, settings);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		installTestTheme();
		selector.handleInput("\n");
		installTestTheme();
		const step2Rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(step2Rendered).toContain("Cursor MAX mode");
		expect(step2Rendered).toContain("MAX off");
		expect(step2Rendered).toContain("MAX on");

		selector.handleInput("[B");
		installTestTheme();
		selector.handleInput("\n");

		expect(calls.length).toBe(1);
		expect(calls[0].role).toBe("default");
		expect(calls[0].maxMode).toBe(true);
	});

	test("Cursor MAX-capable model can explicitly turn MAX off for an existing MAX role", async () => {
		installTestTheme();
		const settings = Settings.isolated({
			modelRoles: { default: `${cursorMaxModel.provider}/${cursorMaxModel.id}:max` },
		});
		const { selector, calls } = createSelector(cursorMaxModel, settings);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		installTestTheme();
		selector.handleInput("\n");
		installTestTheme();
		const step2Rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(step2Rendered).toContain("Cursor MAX mode");

		selector.handleInput("\x1b[A");
		installTestTheme();
		selector.handleInput("\n");

		expect(calls.length).toBe(1);
		expect(calls[0].role).toBe("default");
		expect(calls[0].maxMode).toBe(false);
	});

	test("temporary selection preserves current Cursor MAX mode", async () => {
		installTestTheme();
		const settings = Settings.isolated({
			modelRoles: { default: `${cursorMaxModel.provider}/${cursorMaxModel.id}:max` },
		});
		const { selector, calls } = createSelector(cursorMaxModel, settings, { temporaryOnly: true });
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");

		expect(calls.length).toBe(1);
		expect(calls[0].role).toBeNull();
		expect(calls[0].maxMode).toBeUndefined();
	});
	test("Cursor MAX-capable model: ESC from step2 returns to role step", async () => {
		installTestTheme();
		const settings = Settings.isolated({
			modelRoles: { default: `${cursorMaxModel.provider}/${cursorMaxModel.id}` },
		});
		const { selector, calls } = createSelector(cursorMaxModel, settings);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		installTestTheme();
		selector.handleInput("\n");
		installTestTheme();
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("Cursor MAX mode");

		selector.handleInput("");
		installTestTheme();
		const back = normalizeRenderedText(selector.render(220).join("\n"));
		expect(back).toContain("Set as DEFAULT");
		expect(back).not.toContain("Cursor MAX mode");
		expect(calls.length).toBe(0);
	});

	test("Reasoning model shows step2 thinking list and commits chosen level", async () => {
		installTestTheme();
		const reasoningModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!reasoningModel) throw new Error("Expected bundled model");
		const settings = Settings.isolated({
			modelRoles: { default: `${reasoningModel.provider}/${reasoningModel.id}` },
		});
		const { selector, calls } = createSelector(reasoningModel, settings);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		installTestTheme();
		selector.handleInput("\n");
		installTestTheme();
		const step2Rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(step2Rendered).toContain("Thinking");

		selector.handleInput("\n");
		expect(calls.length).toBe(1);
		expect(calls[0].role).toBe("default");
		expect(calls[0].thinkingLevel).toBeDefined();
	});
});
