import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import {
	ALL_ROLES_SELECTION,
	getAllRolesForSelection,
	type ModelRegistry,
} from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type AllRolesModelTarget, applyModelToAllRoles } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

function getBundledSonnet(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
	return model;
}

interface RecordedTarget {
	target: AllRolesModelTarget;
	setModelCalls: Array<{
		role: string;
		options: { selector?: string; thinkingLevel?: ThinkingLevel; persist?: boolean };
	}>;
	thinkingCalls: Array<{ level: ConfiguredThinkingLevel | undefined; persist?: boolean }>;
}

function createRecordedTarget(): RecordedTarget {
	const setModelCalls: RecordedTarget["setModelCalls"] = [];
	const thinkingCalls: RecordedTarget["thinkingCalls"] = [];
	const target: AllRolesModelTarget = {
		async setModel(_model, role, options) {
			setModelCalls.push({ role, options });
		},
		setThinkingLevel(level, persist) {
			thinkingCalls.push({ level, persist });
		},
	};
	return { target, setModelCalls, thinkingCalls };
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

function createSelector(
	model: Model,
	settings: Settings,
	onSelect: (
		selectedModel: Model,
		role: string | null,
		thinkingLevel?: ConfiguredThinkingLevel,
		selector?: string,
	) => void,
): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: "off" }],
		onSelect,
		() => {},
	);
}

describe("getAllRolesForSelection", () => {
	test("returns the known built-in roles in order without the sentinel", () => {
		const settings = Settings.isolated();
		expect(getAllRolesForSelection(settings)).toEqual([
			"default",
			"smol",
			"slow",
			"vision",
			"plan",
			"designer",
			"commit",
			"task",
		]);
	});

	test("includes custom roles and excludes the sentinel even if configured", () => {
		const settings = Settings.isolated({
			cycleOrder: [ALL_ROLES_SELECTION, "custom-fast"],
		});
		const roles = getAllRolesForSelection(settings);
		expect(roles).toContain("custom-fast");
		expect(roles).not.toContain(ALL_ROLES_SELECTION);
	});
});

describe("applyModelToAllRoles", () => {
	test("applies a concrete thinking level to default (persisted) and every other role", async () => {
		const model = getBundledSonnet();
		const settings = Settings.isolated();
		const { target, setModelCalls, thinkingCalls } = createRecordedTarget();
		const selector = `${model.provider}/${model.id}`;

		await applyModelToAllRoles(target, settings, model, ThinkingLevel.High, selector);

		expect(setModelCalls).toEqual([
			{ role: "default", options: { selector, thinkingLevel: ThinkingLevel.High, persist: true } },
		]);
		for (const role of ["smol", "slow", "vision", "plan", "designer", "commit", "task"]) {
			expect(settings.getModelRole(role)).toBe(`${selector}:${ThinkingLevel.High}`);
		}
		// default is owned by setModel(persist) — the helper must not double-write it.
		expect(settings.getModelRole("default")).toBeUndefined();
		expect(thinkingCalls).toEqual([{ level: ThinkingLevel.High, persist: undefined }]);
	});

	test("persists auto session-wide and writes role values without a thinking suffix", async () => {
		const model = getBundledSonnet();
		const settings = Settings.isolated();
		const { target, setModelCalls, thinkingCalls } = createRecordedTarget();
		const selector = `${model.provider}/${model.id}`;

		await applyModelToAllRoles(target, settings, model, AUTO_THINKING, selector);

		expect(setModelCalls[0]?.options.thinkingLevel).toBeUndefined();
		expect(settings.getModelRole("smol")).toBe(selector);
		expect(thinkingCalls).toEqual([{ level: AUTO_THINKING, persist: true }]);
	});

	test("does not touch the session thinking level when inherit is chosen", async () => {
		const model = getBundledSonnet();
		const settings = Settings.isolated();
		const { target, thinkingCalls } = createRecordedTarget();
		const selector = `${model.provider}/${model.id}`;

		await applyModelToAllRoles(target, settings, model, ThinkingLevel.Inherit, selector);

		expect(settings.getModelRole("task")).toBe(selector);
		expect(thinkingCalls).toEqual([]);
	});

	test("falls back to provider/id when no selector is given", async () => {
		const model = getBundledSonnet();
		const settings = Settings.isolated();
		const { target } = createRecordedTarget();

		await applyModelToAllRoles(target, settings, model, ThinkingLevel.Inherit, undefined);

		expect(settings.getModelRole("smol")).toBe(`${model.provider}/${model.id}`);
	});
});

describe("ModelSelector 'Set for all roles' action", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("offers 'Set for all roles' at the very top of the action menu", async () => {
		installTestTheme();
		const model = getBundledSonnet();
		const settings = Settings.isolated();
		const selector = createSelector(model, settings, () => {});
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));

		expect(rendered).toContain("Set for all roles");
		// It must sit above the concrete per-role actions.
		expect(rendered.indexOf("Set for all roles")).toBeLessThan(rendered.indexOf("Set as"));
	});

	test("fans a single model+thinking choice out to every role via the callback", async () => {
		installTestTheme();
		const model = getBundledSonnet();
		const settings = Settings.isolated();
		const onSelect = vi.fn();
		const selector = createSelector(model, settings, onSelect);
		await Bun.sleep(0);
		installTestTheme();

		// Enter: open action menu (cursor starts on "Set for all roles").
		selector.handleInput("\n");
		installTestTheme();
		const actionView = normalizeRenderedText(selector.render(220).join("\n"));
		expect(actionView).toContain("Action for:");

		// Enter: choose "Set for all roles" -> thinking step.
		selector.handleInput("\n");
		installTestTheme();
		const thinkingView = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingView).toContain("Thinking for: All roles");

		// Enter: confirm the preselected (inherit) thinking level.
		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledTimes(1);
		const [selectedModel, role, thinkingLevel] = onSelect.mock.calls[0] ?? [];
		expect((selectedModel as Model).id).toBe(model.id);
		expect(role).toBe(ALL_ROLES_SELECTION);
		expect(thinkingLevel).toBe(ThinkingLevel.Inherit);
	});
});
