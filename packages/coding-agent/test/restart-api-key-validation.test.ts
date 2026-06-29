import { describe, expect, test } from "bun:test";
import {
	applyRuntimeApiKeyBeforeSessionRestore,
	getPersistedSessionModelProvider,
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

	test("derives restart runtime provider from persisted session models", () => {
		expect(
			getPersistedSessionModelProvider({
				getRestorableModelStrings: () => ["anthropic/claude-sonnet-4-5:high"],
			}),
		).toBe("anthropic");
		expect(
			getPersistedSessionModelProvider({
				getRestorableModelStrings: () => ["not-a-model", "openai/gpt-5"],
			}),
		).toBe("openai");
		expect(getPersistedSessionModelProvider(undefined)).toBeUndefined();
	});

	test("applies runtime API key before restored session model lookup", () => {
		const applied: { provider: string; apiKey: string }[] = [];
		const authStorage = {
			setRuntimeApiKey(provider: string, apiKey: string): void {
				applied.push({ provider, apiKey });
			},
		};
		const restoredSource = {
			getRestorableModelStrings: () => ["restored-provider/restored-model"],
		};

		expect(
			applyRuntimeApiKeyBeforeSessionRestore(
				{ apiKey: "sk-runtime" },
				{ model: { provider: "launch-provider" } },
				undefined,
				authStorage,
			),
		).toBe(true);
		expect(
			applyRuntimeApiKeyBeforeSessionRestore(
				{ apiKey: "sk-runtime", resume: "sess-1" },
				{},
				restoredSource,
				authStorage,
			),
		).toBe(true);
		expect(applied).toEqual([
			{ provider: "launch-provider", apiKey: "sk-runtime" },
			{ provider: "restored-provider", apiKey: "sk-runtime" },
		]);

		expect(applyRuntimeApiKeyBeforeSessionRestore({ apiKey: "sk-runtime" }, {}, restoredSource, authStorage)).toBe(
			false,
		);
		expect(
			applyRuntimeApiKeyBeforeSessionRestore(
				{ apiKey: "sk-runtime", resume: "sess-1" },
				{ modelPattern: "extension/model" },
				restoredSource,
				authStorage,
			),
		).toBe(false);
		expect(applyRuntimeApiKeyBeforeSessionRestore({}, {}, restoredSource, authStorage)).toBe(false);
		expect(applied).toHaveLength(2);
	});
});
