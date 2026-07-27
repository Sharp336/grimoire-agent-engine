import { afterEach, describe, expect, test } from "bun:test";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { ModelRegistry } from "../src/config/model-registry";
import { isXAIHttpCompatProvider, resolveXAIHttpCredentials } from "../src/lib/xai-http";

const SOURCE_ID = "xai-http-compat-test";

function registryWith(keys: Record<string, string>): ModelRegistry {
	return {
		authStorage: { hasNonEnvCredential: (provider: string) => keys[provider] !== undefined },
		getApiKeyForProvider: async (provider: string) => keys[provider],
		getAll: () => [],
		getProviderBaseUrl: () => undefined,
	} as unknown as ModelRegistry;
}

afterEach(() => {
	unregisterOAuthProviders(SOURCE_ID);
});

describe("xAI HTTP compatibility providers", () => {
	test("a declared plugin provider supplies credentials and its HTTP base URL", async () => {
		registerOAuthProvider({
			id: "xai-grok-build",
			name: "xAI Grok Build",
			sourceId: SOURCE_ID,
			login: async () => "unused",
			xaiHttpCompat: true,
			xaiHttpBaseUrl: "https://cli-chat-proxy.grok.com/v1",
		});

		const resolved = await resolveXAIHttpCredentials(registryWith({ "xai-grok-build": "grok-token" }));

		expect(resolved).toEqual({
			provider: "xai-grok-build",
			apiKey: "grok-token",
			baseURL: "https://cli-chat-proxy.grok.com/v1",
		});
		expect(isXAIHttpCompatProvider("xai-grok-build")).toBe(true);
	});

	test("an undeclared provider is never used for xAI HTTP tools", async () => {
		registerOAuthProvider({
			id: "unrelated-provider",
			name: "Unrelated",
			sourceId: SOURCE_ID,
			login: async () => "unused",
		});

		expect(await resolveXAIHttpCredentials(registryWith({ "unrelated-provider": "some-token" }))).toBeNull();
		expect(isXAIHttpCompatProvider("unrelated-provider")).toBe(false);
	});

	test("built-in xAI credentials retain precedence", async () => {
		registerOAuthProvider({
			id: "xai-grok-build",
			name: "xAI Grok Build",
			sourceId: SOURCE_ID,
			login: async () => "unused",
			xaiHttpCompat: true,
		});

		const resolved = await resolveXAIHttpCredentials(
			registryWith({ xai: "plain-key", "xai-grok-build": "grok-token" }),
		);

		expect(resolved?.provider).toBe("xai");
		expect(resolved?.apiKey).toBe("plain-key");
	});
});
