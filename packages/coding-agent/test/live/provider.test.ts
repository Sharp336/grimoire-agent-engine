import { describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { resolveVoiceProvider, resolveVoiceProviderOrder } from "../../src/live/provider";

const authStorage = {
	hasNonEnvCredential: () => true,
	getApiKey: async () => "test-xai-key",
} as unknown as AuthStorage;

describe("voice provider resolution", () => {
	test("honors configured ranking when multiple providers are available", async () => {
		const grokFirst = await resolveVoiceProvider({
			authStorage,
			sessionId: "test-session",
			order: ["grok", "codex"],
		});
		const codexFirst = await resolveVoiceProvider({
			authStorage,
			sessionId: "test-session",
			order: ["codex", "grok"],
		});

		expect(grokFirst.id).toBe("grok");
		expect(codexFirst.id).toBe("codex");
	});

	test("appends unlisted providers in built-in order without duplicates", () => {
		expect(resolveVoiceProviderOrder(["grok", "grok"])).toEqual(["grok", "codex"]);
	});

	test("allows an explicit unavailable provider override", async () => {
		const unavailable = {
			hasNonEnvCredential: () => false,
			getApiKey: async () => undefined,
		} as unknown as AuthStorage;

		const provider = await resolveVoiceProvider({
			authStorage: unavailable,
			sessionId: "test-session",
			forced: "grok",
		});

		expect(provider.id).toBe("grok");
	});
});
