import { describe, expect, test } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { saveProfile, switchProfileAndResolve } from "@oh-my-pi/pi-coding-agent/config/profiles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const mockModels: Model<"anthropic-messages">[] = [
	buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	}),
];

describe("switchProfileAndResolve — needsReset", () => {
	test("returns needsReset=true when profile has no explicit default role", () => {
		const settings = Settings.isolated();

		// Save a profile while no default model role is set — simulates the
		// "automatic default" state where modelRoles.default is absent.
		saveProfile(settings, "auto-default");

		// Verify the profile was saved with no default role
		const profiles = settings.get("profiles");
		expect(profiles).toBeDefined();
		expect(profiles?.["auto-default"]).toBeDefined();

		const result = switchProfileAndResolve(settings, "auto-default", mockModels);

		expect(result.ok).toBe(true);
		expect(result.needsReset).toBe(true);
		expect(result.model).toBeUndefined();
	});

	test("returns model (no needsReset) when profile has explicit default role", () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");

		saveProfile(settings, "explicit-default");

		const result = switchProfileAndResolve(settings, "explicit-default", mockModels);

		expect(result.ok).toBe(true);
		expect(result.needsReset).toBeUndefined();
		expect(result.model).toBeDefined();
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
	});

	test("returns ok=false for nonexistent profile", () => {
		const settings = Settings.isolated();

		const result = switchProfileAndResolve(settings, "does-not-exist", mockModels);

		expect(result.ok).toBe(false);
		expect(result.needsReset).toBeUndefined();
		expect(result.model).toBeUndefined();
	});

	test("switching from explicit-default profile to no-default profile signals reset", () => {
		const settings = Settings.isolated();

		// Profile A: has explicit default
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		saveProfile(settings, "profile-a");

		// Profile B: no explicit default (auto)
		settings.setModelRole("default", "");
		saveProfile(settings, "profile-b");

		// Switch to profile-a first (explicit model)
		const resultA = switchProfileAndResolve(settings, "profile-a", mockModels);
		expect(resultA.ok).toBe(true);
		expect(resultA.model).toBeDefined();
		expect(resultA.needsReset).toBeUndefined();

		// Now switch to profile-b (no default) — should signal needsReset
		const resultB = switchProfileAndResolve(settings, "profile-b", mockModels);
		expect(resultB.ok).toBe(true);
		expect(resultB.needsReset).toBe(true);
		expect(resultB.model).toBeUndefined();
	});
});
