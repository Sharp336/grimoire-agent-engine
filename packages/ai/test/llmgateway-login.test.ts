import { afterEach, describe, expect, test } from "bun:test";
import { loginLLMGateway } from "@oh-my-pi/pi-ai/registry/llmgateway";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";

const originalLLMGatewayApiKey = Bun.env.LLM_GATEWAY_API_KEY;

afterEach(() => {
	if (originalLLMGatewayApiKey === undefined) {
		delete Bun.env.LLM_GATEWAY_API_KEY;
	} else {
		Bun.env.LLM_GATEWAY_API_KEY = originalLLMGatewayApiKey;
	}
});

describe("loginLLMGateway", () => {
	test("registers LLM Gateway in the OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "llmgateway");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("LLM Gateway");
		expect(provider?.available).toBe(true);
	});

	test("resolves LLM_GATEWAY_API_KEY from environment", () => {
		Bun.env.LLM_GATEWAY_API_KEY = "llmgtwy_env_key";
		expect(getEnvApiKey("llmgateway")).toBe("llmgtwy_env_key");
	});

	test("returns the trimmed API key without network validation", async () => {
		let fetchCalled = false;
		const key = await loginLLMGateway({
			fetch: async () => {
				fetchCalled = true;
				return new Response("unexpected", { status: 500 });
			},
			onPrompt: async () => "  llmgtwy_TESTKEY  ",
			onAuth: () => {},
			onProgress: () => {},
		});

		expect(key).toBe("llmgtwy_TESTKEY");
		expect(fetchCalled).toBe(false);
	});
});
