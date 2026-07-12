import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage, CompletionProbeInput } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { createStrictCompletionProbe } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

const successfulCompletion = {
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "openai",
	model: "gpt-4.1-mini",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
} satisfies AssistantMessage;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("auth-gateway strict completion probe", () => {
	test("skips OAuth-only providers without passing their access token to completeSimple", async () => {
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		const input = {
			provider: "xai-grok-build",
			credentialId: 7,
			credential: { type: "oauth", accessToken: "oauth-access-token" },
			signal: new AbortController().signal,
		} satisfies CompletionProbeInput;

		const result = await createStrictCompletionProbe()(input);

		expect(result).toEqual({
			ok: null,
			reason: "strict completion probe is unavailable for OAuth-only provider xai-grok-build",
		});
		expect(completeSimpleSpy).not.toHaveBeenCalled();
	});

	test("continues to probe non-OAuth providers with their API key", async () => {
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(successfulCompletion);
		const input = {
			provider: "openai",
			credentialId: 8,
			credential: { type: "api_key", apiKey: "ordinary-api-key" },
			signal: new AbortController().signal,
		} satisfies CompletionProbeInput;

		const result = await createStrictCompletionProbe()(input);

		expect(result.ok).toBe(true);
		expect(completeSimpleSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ apiKey: "ordinary-api-key" }),
		);
	});
});
