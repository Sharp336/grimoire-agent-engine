import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	getAllModelPresetIds,
	modelPresetsFromUnknown,
	resolveModelPreset,
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
			modelRoles: { default: "test/default", smol: "test/smol", slow: "test/slow", designer: "test/designer" },
		});
		// Simulate a prior preset (e.g. ultra) having overlaid xhigh selectors.
		settings.setSessionPresetRoles({ slow: "test/slow:xhigh", default: "test/slow:xhigh" });
		const balanced = resolveModelPreset(settings, registry, availableModels, "balanced");
		const slow = balanced.roles.find(role => role.role === "slow");
		expect(slow?.model.id).toBe("slow");
		// Would be true (xhigh) if the prior overlay leaked into resolution.
		expect(slow?.explicitThinkingLevel).toBe(false);
	});

	it("overrideModelRoles composes over base instead of replacing the map", () => {
		const settings = Settings.isolated({ modelRoles: { default: "a", slow: "b", task: "c" } });
		settings.overrideModelRoles({ smol: "X" });
		expect(settings.getModelRoles()).toEqual({ default: "a", slow: "b", task: "c", smol: "X" });
	});
});
