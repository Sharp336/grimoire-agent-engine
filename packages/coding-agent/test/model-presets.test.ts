import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { resolveModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-presets";
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
