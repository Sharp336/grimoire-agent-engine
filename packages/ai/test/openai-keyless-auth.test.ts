import { describe, expect, test } from "bun:test";
import { kNoAuth } from "@oh-my-pi/pi-ai";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";

describe("OpenAI keyless authentication", () => {
	test("does not turn the no-auth sentinel into an Authorization header", () => {
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "local-openai",
				id: "local-model",
				baseUrl: "http://127.0.0.1:8080/v1",
			},
			{ apiKey: kNoAuth, messages: [] },
		);

		expect(setup.headers).not.toHaveProperty("Authorization");
	});

	test("keeps Bearer authorization for authenticated providers", () => {
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "openai-compatible",
				id: "authenticated-model",
				baseUrl: "https://api.example.com/v1",
			},
			{ apiKey: "secret-key", messages: [] },
		);

		expect(setup.headers.Authorization).toBe("Bearer secret-key");
	});
});
