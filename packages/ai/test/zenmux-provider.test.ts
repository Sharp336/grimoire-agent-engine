import { describe, expect, test } from "bun:test";
import { getBundledModels } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { zenmuxModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalZenMuxApiKey = Bun.env.ZENMUX_API_KEY;

describe("zenmux provider support", () => {
	test("resolves ZENMUX_API_KEY from environment", () => {
		Bun.env.ZENMUX_API_KEY = "zenmux-test-key";
		expect(getEnvApiKey("zenmux")).toBe("zenmux-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "zenmux");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("anthropic/claude-opus-4.6");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("ZENMUX_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.zenmux).toBe("anthropic/claude-opus-4.6");
	});

	test("registers ZenMux in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "zenmux");
		expect(provider?.name).toBe("ZenMux");
	});

	test("uses bundled models without dynamic discovery", () => {
		const options = zenmuxModelManagerOptions({ apiKey: "test-key" });
		expect(options.providerId).toBe("zenmux");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	test("bundled models have correct routing and maxTokens", () => {
		const models = getBundledModels("zenmux");

		// Anthropic models route to anthropic-messages API
		const claudeOpus = models.find(m => m.id === "anthropic/claude-opus-4.6");
		expect(claudeOpus).toBeDefined();
		expect(claudeOpus?.api).toBe("anthropic-messages");
		expect(claudeOpus?.baseUrl).toBe("https://zenmux.ai/api/anthropic");
		expect(claudeOpus?.maxTokens).toBe(128000);
		expect(claudeOpus?.reasoning).toBe(true);

		// Non-Anthropic models route to openai-completions API
		const gpt5 = models.find(m => m.id === "openai/gpt-5");
		expect(gpt5).toBeDefined();
		expect(gpt5?.api).toBe("openai-completions");
		expect(gpt5?.baseUrl).toBe("https://zenmux.ai/api/v1");
		expect(gpt5?.maxTokens).toBe(64000);
	});
});

// Cleanup
if (originalZenMuxApiKey === undefined) {
	delete Bun.env.ZENMUX_API_KEY;
} else {
	Bun.env.ZENMUX_API_KEY = originalZenMuxApiKey;
}
