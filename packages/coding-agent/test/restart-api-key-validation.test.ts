import { describe, expect, test } from "bun:test";
import {
	applyRuntimeApiKeyForRestoredSession,
	requiresLaunchModelForRuntimeApiKey,
} from "@oh-my-pi/pi-coding-agent/main";

describe("restart runtime API key validation", () => {
	test("requires a launch model only for fresh CLI API-key runs", () => {
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime" }, {})).toBe(true);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime", resume: "sess-1" }, {})).toBe(false);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime", continue: true }, {})).toBe(false);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime", fork: "sess-1" }, {})).toBe(false);
		expect(requiresLaunchModelForRuntimeApiKey({ apiKey: "sk-runtime" }, { modelPattern: "openai/gpt-5" })).toBe(
			false,
		);
		expect(requiresLaunchModelForRuntimeApiKey({}, {})).toBe(false);
	});

	test("applies runtime API key after restored session model supplies the provider", () => {
		const applied: { provider: string; apiKey: string }[] = [];
		const authStorage = {
			setRuntimeApiKey(provider: string, apiKey: string): void {
				applied.push({ provider, apiKey });
			},
		};

		applyRuntimeApiKeyForRestoredSession(
			{ apiKey: "sk-runtime" },
			{},
			{ model: { provider: "restored-provider" } },
			authStorage,
		);
		expect(applied).toEqual([{ provider: "restored-provider", apiKey: "sk-runtime" }]);

		applyRuntimeApiKeyForRestoredSession(
			{ apiKey: "sk-runtime" },
			{ model: { provider: "launch-provider" } },
			{ model: { provider: "restored-provider" } },
			authStorage,
		);
		applyRuntimeApiKeyForRestoredSession({ apiKey: "sk-runtime" }, {}, {}, authStorage);
		applyRuntimeApiKeyForRestoredSession({}, {}, { model: { provider: "restored-provider" } }, authStorage);
		expect(applied).toHaveLength(1);
	});
});
