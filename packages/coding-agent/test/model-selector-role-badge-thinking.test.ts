import { beforeAll, describe, expect, test, vi } from "bun:test";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return (
		text
			// strip ANSI escapes
			.replace(/\x1b\[[0-9;]*m/g, "")
			// collapse whitespace
			.replace(/\s+/g, " ")
			.trim()
	);
}

function createSelector(
	model: Model,
	settings: Settings,
	options?: { models?: Model[]; terminalRows?: number },
): ModelSelectorComponent {
	const models = options?.models ?? [model];
	const modelRegistry = {
		getAll: () => models,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = {
		terminal: { rows: options?.terminalRows ?? 24 },
		requestRender: vi.fn(),
	} as unknown as TUI;

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		models.map(model => ({ model, thinkingLevel: "off" })),
		() => {},
		() => {},
	);
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

describe("ModelSelector role badge thinking display", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("renders per-role thinking labels with inherit mode to avoid badge ambiguity", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			modelRoles: {
				default: `${model.provider}/${model.id}`,
				smol: `${model.provider}/${model.id}:minimal`,
				slow: `${model.provider}/${model.id}`,
				plan: `${model.provider}/${model.id}:high`,
				commit: `${model.provider}/${model.id}:medium`,
			},
		});

		const selector = createSelector(model, settings);

		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("DEFAULT (inherit)");
		expect(rendered).toContain("SMOL (min)");
		expect(rendered).toContain("SLOW (inherit)");
		expect(rendered).toContain("PLAN (high)");
		expect(rendered).toContain("COMMIT (medium)");
		expect(rendered).not.toContain("Role Thinking:");

		selector.handleInput("\n");
		installTestTheme();
		const menuRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(menuRendered).toContain("Set as DEFAULT (Default)");
		expect(menuRendered).toContain("Set as SMOL (Fast)");
		expect(menuRendered).toContain("Set as SLOW (Thinking)");
		expect(menuRendered).toContain("Set as PLAN (Architect)");
		expect(menuRendered).toContain("Set as COMMIT (Commit)");
	});

	test("shows custom roles from cycleOrder/modelRoles and honors built-in metadata overrides", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			cycleOrder: ["smol", "custom-fast", "default"],
			modelRoles: {
				default: `${model.provider}/${model.id}`,
				"custom-fast": `${model.provider}/${model.id}:low`,
				smol: `${model.provider}/${model.id}`,
			},
			modelTags: {
				smol: { name: "Quick", color: "error" },
			},
		});

		const selector = createSelector(model, settings);
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("custom-fast (low)");
		expect(rendered).toContain("SMOL (inherit)");

		selector.handleInput("\n");
		installTestTheme();
		const menuRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(menuRendered).toContain("Set as custom-fast");
		expect(menuRendered).toContain("Set as SMOL (Quick)");
	});

	test("keeps the model list inside the terminal viewport while selection moves down", async () => {
		installTestTheme();
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const models = Array.from({ length: 12 }, (_, index) => ({
			...baseModel,
			id: `test-model-${index.toString().padStart(2, "0")}`,
			name: `Test Model ${index.toString().padStart(2, "0")}`,
		}));
		const settings = Settings.isolated({});
		const selector = createSelector(models[0], settings, { models, terminalRows: 18 });

		await Bun.sleep(0);
		installTestTheme();

		for (let i = 0; i < 6; i++) {
			selector.handleInput("\x1b[B");
		}

		const renderedLines = selector.render(220);
		const rendered = normalizeRenderedText(renderedLines.join("\n"));
		expect(renderedLines).toHaveLength(18);
		expect(rendered).toContain("test-model-06");
		expect(rendered).not.toContain("test-model-02");
	});
});
