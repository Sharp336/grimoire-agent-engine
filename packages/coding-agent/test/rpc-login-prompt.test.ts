import { describe, expect, test } from "bun:test";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/oauth";
import { resolveRpcLoginPrompt } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

const interactivePromptError =
	"Provider 'test-provider' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.";
const secretPromptError =
	"Provider 'test-provider' requires secret input which is not supported in RPC mode. Use the terminal UI to log in.";

async function expectRejectedWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
	let caught: unknown;
	try {
		await promise;
	} catch (error: unknown) {
		caught = error;
	}

	expect(caught).toBeInstanceOf(Error);
	if (!(caught instanceof Error)) throw new Error("Expected the prompt to reject with an Error");
	expect(caught.message).toBe(message);
}

describe("resolveRpcLoginPrompt", () => {
	test("returns blank locally for optional secrets before authentication without requesting RPC input", async () => {
		let authChecks = 0;
		let inputCalls = 0;

		const result = await resolveRpcLoginPrompt(
			{ message: "Paste a refresh token", secret: true, allowEmpty: true },
			{
				providerId: "test-provider",
				authEmitted: () => {
					authChecks++;
					return false;
				},
				requestInput: async () => {
					inputCalls++;
					return "must never be requested";
				},
			},
		);

		expect(result).toBe("");
		expect(authChecks).toBe(0);
		expect(inputCalls).toBe(0);
	});

	test("rejects required secrets with terminal UI guidance without requesting RPC input", async () => {
		let inputCalls = 0;

		await expectRejectedWithMessage(
			resolveRpcLoginPrompt(
				{ message: "Paste a refresh token", secret: true },
				{
					providerId: "test-provider",
					authEmitted: () => true,
					requestInput: async () => {
						inputCalls++;
						return "must never be requested";
					},
				},
			),
			secretPromptError,
		);

		expect(inputCalls).toBe(0);
	});

	test("preserves the pre-auth rejection for ordinary prompts", async () => {
		let inputCalls = 0;

		await expectRejectedWithMessage(
			resolveRpcLoginPrompt(
				{ message: "Choose an account" },
				{
					providerId: "test-provider",
					authEmitted: () => false,
					requestInput: async () => {
						inputCalls++;
						return "must never be requested";
					},
				},
			),
			interactivePromptError,
		);

		expect(inputCalls).toBe(0);
	});

	test("forwards ordinary post-auth prompts to RPC input", async () => {
		const prompt: OAuthPrompt = { message: "Paste the redirect URL", placeholder: "https://localhost/callback" };
		let requestedPrompt: OAuthPrompt | undefined;

		const result = await resolveRpcLoginPrompt(prompt, {
			providerId: "test-provider",
			authEmitted: () => true,
			requestInput: async request => {
				requestedPrompt = request;
				return "https://localhost/callback?code=ordinary";
			},
		});

		expect(requestedPrompt).toEqual(prompt);
		expect(result).toBe("https://localhost/callback?code=ordinary");
	});
});
