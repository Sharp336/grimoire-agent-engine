import { afterEach, describe, expect, test } from "bun:test";
import { loginLLMGateway } from "@oh-my-pi/pi-ai/registry/llmgateway";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const CHAT_COMPLETIONS_HOST = "api.llmgateway.io";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const originalLLMGatewayApiKey = Bun.env.LLM_GATEWAY_API_KEY;

afterEach(() => {
	if (originalLLMGatewayApiKey === undefined) {
		delete Bun.env.LLM_GATEWAY_API_KEY;
	} else {
		Bun.env.LLM_GATEWAY_API_KEY = originalLLMGatewayApiKey;
	}
});

function makeController(fetchImpl: FetchImpl): Parameters<typeof loginLLMGateway>[0] {
	return {
		fetch: fetchImpl,
		onPrompt: async () => "  llmgtwy_TESTKEY  ",
		onAuth: () => {},
		onProgress: () => {},
	};
}

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

	test("validates the API key against chat completions", async () => {
		let capturedUrl = "";
		let capturedAuth = "";
		let capturedBody = "";
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			const headers = new Headers(init?.headers);
			capturedAuth = headers.get("Authorization") ?? "";
			capturedBody = String(init?.body ?? "");
			return new Response(JSON.stringify({ id: "chatcmpl-test" }), { status: 200 });
		};

		const key = await loginLLMGateway(makeController(fetchImpl));

		expect(key).toBe("llmgtwy_TESTKEY");
		expect(capturedUrl).not.toBe("");
		const url = new URL(capturedUrl);
		expect(url.host).toBe(CHAT_COMPLETIONS_HOST);
		expect(url.pathname).toBe(CHAT_COMPLETIONS_PATH);
		expect(capturedAuth).toBe("Bearer llmgtwy_TESTKEY");
		expect(JSON.parse(capturedBody)).toMatchObject({
			model: "gpt-4o-mini",
			max_tokens: 1,
			temperature: 0,
		});
	});

	test("surfaces upstream auth failures with status", async () => {
		const fetchImpl: FetchImpl = async () => new Response("invalid api key", { status: 401 });

		await expect(loginLLMGateway(makeController(fetchImpl))).rejects.toThrow(
			/LLM Gateway API key validation failed \(401\)/,
		);
	});
});
