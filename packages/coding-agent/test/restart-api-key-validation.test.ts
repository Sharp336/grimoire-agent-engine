import { describe, expect, test } from "bun:test";
import {
	applyRuntimeApiKeyBeforeSessionRestore,
	applyRuntimeApiKeyForRestoredSession,
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
		).toBe("launch-provider");
		expect(
			applyRuntimeApiKeyBeforeSessionRestore(
				{ apiKey: "sk-runtime", resume: "sess-1" },
				{},
				restoredSource,
				authStorage,
			),
		).toBe("restored-provider");
		expect(applied).toEqual([
			{ provider: "launch-provider", apiKey: "sk-runtime" },
			{ provider: "restored-provider", apiKey: "sk-runtime" },
		]);

		expect(applyRuntimeApiKeyBeforeSessionRestore({ apiKey: "sk-runtime" }, {}, restoredSource, authStorage)).toBe(
			undefined,
		);
		expect(
			applyRuntimeApiKeyBeforeSessionRestore(
				{ apiKey: "sk-runtime", resume: "sess-1" },
				{ modelPattern: "extension/model" },
				restoredSource,
				authStorage,
			),
		).toBeUndefined();
		expect(applyRuntimeApiKeyBeforeSessionRestore({}, {}, restoredSource, authStorage)).toBeUndefined();
		expect(applied).toHaveLength(2);
	});

	test("uses the original provider when installing restart API keys before restore", () => {
		const applied: { provider: string; apiKey: string }[] = [];
		const authStorage = {
			setRuntimeApiKey(provider: string, apiKey: string): void {
				applied.push({ provider, apiKey });
			},
		};
		const restoredSource = {
			getRestorableModelStrings: () => ["anthropic/claude-sonnet-4-5"],
		};

		expect(
			applyRuntimeApiKeyBeforeSessionRestore(
				{ apiKey: "sk-runtime", resume: "sess-1" },
				{},
				restoredSource,
				authStorage,
				"openai",
			),
		).toBe("openai");
		expect(applied).toEqual([{ provider: "openai", apiKey: "sk-runtime" }]);
	});

	test("keeps post-restore API key handoff scoped to the original provider", () => {
		const applied: { provider: string; apiKey: string }[] = [];
		const authStorage = {
			setRuntimeApiKey(provider: string, apiKey: string): void {
				applied.push({ provider, apiKey });
			},
		};

		expect(
			applyRuntimeApiKeyForRestoredSession(
				{ apiKey: "sk-runtime" },
				{},
				{ model: { provider: "anthropic" } },
				authStorage,
				"openai",
			),
		).toBe("openai");
		expect(applied).toEqual([{ provider: "openai", apiKey: "sk-runtime" }]);
	});
});
