import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	getAllModelPresetIds,
	modelPresetsFromUnknown,
	resolveModelPreset,
	resolveModelPresetOverlay,
	resolvePresetId,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id, api: "test" } as unknown as Model<Api>;
}

const availableModels = [
	model("test", "default"),
	model("test", "smol"),
	model("test", "slow"),
	model("test", "designer"),
];

const registry = {} as ModelRegistry;

function presetSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		modelRoles: {
			default: "test/default",
			smol: "test/smol",
			slow: "test/slow",
			designer: "test/designer",
		},
		...overrides,
	});
}

describe("model presets", () => {
	it("resolves all built-in presets through role aliases", () => {
		const settings = presetSettings();

		for (const id of ["budget", "balanced", "smart", "ultra"] as const) {
			const preset = resolveModelPreset(settings, registry, availableModels, id);
			expect(preset.id).toBe(id);
			expect(preset.defaultRole.model.provider).toBe("test");
			expect(preset.roles.some(role => role.role === "default")).toBe(true);
		}
	});

	it("user preset overrides replace only configured roles", () => {
		const settings = presetSettings({ modelPresets: { smart: { default: "test/default" } } });

		const preset = resolveModelPreset(settings, registry, availableModels, "smart");

		expect(preset.defaultRole.selector).toBe("test/default");
		expect(preset.roles.find(role => role.role === "slow")?.selector).toBe("pi/slow:high");
	});

	it("throws before returning a partial preset when a role cannot resolve", () => {
		const settings = presetSettings({ modelPresets: { smart: { task: "missing/provider" } } });

		expect(() => resolveModelPreset(settings, registry, availableModels, "smart")).toThrow(
			"Preset Smart cannot resolve role task: missing/provider",
		);
	});
});

describe("custom preset identity", () => {
	it("lists built-ins first, then custom presets in definition order", () => {
		const settings = Settings.isolated({
			modelPresets: { "fast-cheap": { default: "test/smol" }, nightly: { default: "test/slow" } },
		});
		expect(getAllModelPresetIds(settings)).toEqual(["budget", "balanced", "smart", "ultra", "fast-cheap", "nightly"]);
	});

	it("does not duplicate a built-in id overridden via modelPresets", () => {
		const settings = Settings.isolated({ modelPresets: { smart: { default: "test/slow" } } });
		expect(getAllModelPresetIds(settings)).toEqual(["budget", "balanced", "smart", "ultra"]);
	});

	it("resolvePresetId matches case-insensitively and rejects unknown names", () => {
		const settings = Settings.isolated({ modelPresets: { "Fast-Cheap": { default: "test/smol" } } });
		expect(resolvePresetId(settings, "SMART")).toBe("smart");
		expect(resolvePresetId(settings, "fast-cheap")).toBe("Fast-Cheap");
		expect(resolvePresetId(settings, "  ultra  ")).toBe("ultra");
		expect(resolvePresetId(settings, "nope")).toBeUndefined();
	});

	it("resolveModelPreset throws for an unknown preset id", () => {
		const settings = presetSettings();
		expect(() => resolveModelPreset(settings, registry, availableModels, "nope")).toThrow("Unknown preset: nope");
	});

	it("modelPresetsFromUnknown keeps arbitrary keys and drops non-object values", () => {
		const parsed = modelPresetsFromUnknown({ "fast-cheap": { default: "pi/smol" }, bad: "nope", arr: [1, 2] });
		expect(parsed["fast-cheap"]).toEqual({ default: "pi/smol" });
		expect(parsed.bad).toBeUndefined();
		expect(parsed.arr).toBeUndefined();
	});

	it("modelPresetsFromUnknown drops dangerous prototype keys while keeping normal arbitrary keys", () => {
		const parsed = modelPresetsFromUnknown(
			JSON.parse('{"__proto__":{"default":"test/smol"},"custom":{"default":"test/default"}}'),
		);

		expect(Object.getPrototypeOf(parsed)).toBeNull();
		expect(parsed.__proto__).toBeUndefined();
		expect("default" in Object.prototype).toBe(false);
		expect(parsed.custom).toEqual({ default: "test/default" });
		expect(getAllModelPresetIds(Settings.isolated({ modelPresets: parsed }))).toEqual([
			"budget",
			"balanced",
			"smart",
			"ultra",
			"custom",
		]);
	});
});

describe("preset overlay (non-destructive apply)", () => {
	it("overlay preserves base roles it does not name", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "test/default", slow: "test/slow", vision: "test/vision" },
		});
		settings.setSessionPresetRoles({ default: "test/smol", slow: "test/smol" });
		expect(settings.getModelRole("default")).toBe("test/smol");
		expect(settings.getModelRole("vision")).toBe("test/vision");
	});

	it("clearing the overlay restores base roles", () => {
		const settings = Settings.isolated({ modelRoles: { default: "test/default" } });
		settings.setSessionPresetRoles({ default: "test/smol" });
		expect(settings.getModelRole("default")).toBe("test/smol");
		settings.setSessionPresetRoles({});
		expect(settings.getModelRole("default")).toBe("test/default");
	});

	it("resolves preset aliases against base config, not a prior preset overlay", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "test/default", slow: "test/slow", designer: "test/designer" },
		});
		// Simulate a prior preset overlay: smol exists only in the overlay, so pi/smol
		// must fall back through the base default instead of chaining to the overlay.
		settings.setSessionPresetRoles({ smol: "test/smol", slow: "test/slow:xhigh", default: "test/slow:xhigh" });
		const balanced = resolveModelPreset(settings, registry, availableModels, "balanced");
		const smol = balanced.roles.find(role => role.role === "smol");
		const slow = balanced.roles.find(role => role.role === "slow");
		expect(smol?.model.id).toBe("default");
		expect(slow?.model.id).toBe("slow");
		// Would be true (xhigh) if the prior overlay leaked into resolution.
		expect(slow?.explicitThinkingLevel).toBe(false);
	});

	it("does not inherit overlay-only vision into the budget preset", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "test/default", smol: "test/smol", slow: "test/slow", designer: "test/designer" },
		});
		settings.setSessionPresetRoles({ vision: "missing/vision" });

		const budget = resolveModelPreset(settings, registry, availableModels, "budget");

		expect(budget.roles.some(role => role.role === "vision")).toBe(false);
	});

	it("overrideModelRoles composes over base instead of replacing the map", () => {
		const settings = Settings.isolated({ modelRoles: { default: "a", slow: "b", task: "c" } });
		settings.overrideModelRoles({ smol: "X" });
		expect(settings.getModelRoles()).toEqual({ default: "a", slow: "b", task: "c", smol: "X" });
	});

	it("resolves preset pi/default aliases via the deferred --model when default is pinned", () => {
		// No base default role: a deferred `--model X` pins `default` but is not yet in
		// the base role map. The overlay resolver must use the deferred selector for
		// `pi/default` aliases instead of falling back to the built-in priority chain.
		const settings = Settings.isolated({ modelPresets: { mine: { task: "pi/default" } } });
		const overlay = resolveModelPresetOverlay(settings, registry, availableModels, "mine", new Set(["default"]), {
			default: "test/slow",
		});
		expect(overlay.roles.find(role => role.role === "task")?.model.id).toBe("slow");
		// `default` is pinned, so the overlay never carries it (the lower layer wins).
		expect(overlay.roles.some(role => role.role === "default")).toBe(false);
	});
});
