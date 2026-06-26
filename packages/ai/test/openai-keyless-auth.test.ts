import { describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";

const atomicChatModel = {
	provider: "atomic-chat",
	id: "gemma-local",
	baseUrl: "http://127.0.0.1:1337/v1",
};

describe("OpenAI keyless bearer auth", () => {
	test("omits Authorization for registry kNoAuth sentinel", () => {
		const setup = resolveOpenAIRequestSetup(atomicChatModel, {
			apiKey: "N/A",
			messages: [],
		});

		expect(setup.headers.Authorization).toBeUndefined();
	});

	test("omits Authorization for local provider placeholder tokens", () => {
		const setup = resolveOpenAIRequestSetup(atomicChatModel, {
			apiKey: "atomic-chat-local",
			messages: [],
		});

		expect(setup.headers.Authorization).toBeUndefined();
	});

	test("still sends Authorization for real API keys", () => {
		const setup = resolveOpenAIRequestSetup(atomicChatModel, {
			apiKey: "sk-real-key",
			messages: [],
		});

		expect(setup.headers.Authorization).toBe("Bearer sk-real-key");
	});
});
