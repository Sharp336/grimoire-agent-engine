import { describe, expect, it } from "bun:test";
import { streamKiro } from "@oh-my-pi/pi-ai/providers/kiro";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function model(baseUrl: string | null = "https://kiro.invalid"): Model<"kiro-agent"> {
	const built = buildModel({
		id: "kiro-request-fixture",
		name: "Kiro Request Fixture",
		api: "kiro-agent",
		provider: "kiro",
		baseUrl: baseUrl ?? "https://placeholder.invalid",
		reasoning: false,
		input: ["text"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
	if (baseUrl === null) (built as { baseUrl: string | undefined }).baseUrl = undefined;
	return built;
}

async function capturePayload(context: Context): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await streamKiro(model(), context, {
		apiKey: "token",
		onPayload: value => {
			payload = value as Record<string, unknown>;
		},
		fetch: async () => new Response("fixture", { status: 400 }),
	}).result();
	if (!payload) throw new Error("Kiro did not build a payload");
	return payload;
}

describe("Kiro request encoding", () => {
	it("renders the system and user envelope from the static template", async () => {
		const payload = await capturePayload({
			systemPrompt: ["System one", "System two"],
			messages: [{ role: "user", content: "User request", timestamp: 1 }],
		});
		const state = payload.conversationState as Record<string, unknown>;
		const current = state.currentMessage as { userInputMessage: { content: string } };
		expect(current.userInputMessage.content).toBe("System one\n\nSystem two\n\nUser request");
	});

	it("preserves completed tool-result batches in history", async () => {
		const payload = await capturePayload({
			messages: [
				{ role: "user", content: "Read it", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } }],
					api: "kiro-agent",
					provider: "kiro",
					model: "fixture",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file data" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "Summarize it", timestamp: 4 },
			],
		});
		const state = payload.conversationState as { history: Array<Record<string, unknown>> };
		expect(state.history[2]).toEqual({
			userInputMessage: {
				content: "Tool results provided.",
				userInputMessageContext: {
					toolResults: [{ toolUseId: "call-1", status: "success", content: [{ text: "file data" }] }],
				},
				origin: "KIRO_CLI",
				modelId: "kiro-request-fixture",
			},
		});
	});

	it("rejects image content instead of replacing its bytes with placeholder text", async () => {
		let fetchCalls = 0;
		const result = await streamKiro(
			model(),
			{
				messages: [
					{ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1 },
				],
			},
			{
				apiKey: "token",
				fetch: async () => {
					fetchCalls += 1;
					return new Response();
				},
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("supports text input only");
		expect(fetchCalls).toBe(0);
	});

	it("uses the profile ARN region for a runtime request without an explicit endpoint", async () => {
		let requestUrl = "";
		await streamKiro(
			model(null),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: JSON.stringify({
					accessToken: "token",
					profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/test",
				}),
				fetch: async input => {
					requestUrl = String(input);
					return new Response("fixture", { status: 400 });
				},
			},
		).result();
		expect(requestUrl).toBe("https://runtime.eu-central-1.kiro.dev/");
	});
});
