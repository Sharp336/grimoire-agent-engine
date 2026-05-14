import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { searchAnthropic } from "../../src/web/search/providers/anthropic";

const originalAnthropicSearchApiKey = process.env.ANTHROPIC_SEARCH_API_KEY;
const originalAnthropicSearchBaseUrl = process.env.ANTHROPIC_SEARCH_BASE_URL;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

describe("Anthropic web search provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("ANTHROPIC_SEARCH_API_KEY", originalAnthropicSearchApiKey);
		restoreEnv("ANTHROPIC_SEARCH_BASE_URL", originalAnthropicSearchBaseUrl);
	});

	it("passes the caller abort signal to the Anthropic request", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "test-anthropic-key";
		process.env.ANTHROPIC_SEARCH_BASE_URL = "https://api.anthropic.test";
		const controller = new AbortController();
		let capturedSignal: AbortSignal | null | undefined;

		using _hook = hookFetch((_input, init) => {
			capturedSignal = init?.signal as AbortSignal | null | undefined;
			return new Response(
				JSON.stringify({
					id: "msg_test",
					model: "claude-haiku-4-5",
					content: [{ type: "text", text: "Anthropic answer" }],
					usage: {
						input_tokens: 1,
						output_tokens: 1,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		await searchAnthropic({ query: "latest AI news", signal: controller.signal });

		expect(capturedSignal).toBe(controller.signal);
	});
});
