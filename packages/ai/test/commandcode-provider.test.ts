import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { COMMAND_CODE_MODELS } from "../src/provider-models/commandcode";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { streamCommandCode } from "../src/providers/commandcode";
import { getEnvApiKey } from "../src/stream";
import type { Context, Model } from "../src/types";
import { getOAuthProviders } from "../src/utils/oauth";

const originalApiKey = Bun.env.COMMANDCODE_API_KEY;

afterEach(() => {
	if (originalApiKey === undefined) {
		delete Bun.env.COMMANDCODE_API_KEY;
	} else {
		Bun.env.COMMANDCODE_API_KEY = originalApiKey;
	}
});

function ndjsonResponse(events: unknown[], trailingNewline = true): Response {
	return new Response(`${events.map(event => JSON.stringify(event)).join("\n")}${trailingNewline ? "\n" : ""}`, {
		status: 200,
		headers: { "Content-Type": "application/x-ndjson" },
	});
}

describe("Command Code native provider", () => {
	it("registers native models, auth catalog metadata, and env-key discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "commandcode");
		expect(descriptor?.defaultModel).toBe("deepseek/deepseek-v4-flash");
		expect(DEFAULT_MODEL_PER_PROVIDER.commandcode).toBe("deepseek/deepseek-v4-flash");
		expect(getOAuthProviders().find(item => item.id === "commandcode")?.name).toBe("Command Code");

		Bun.env.COMMANDCODE_API_KEY = "cc-test-key";
		expect(getEnvApiKey("commandcode")).toBe("cc-test-key");

		const bundled = getBundledModel("commandcode", "deepseek/deepseek-v4-flash");
		expect(bundled?.api).toBe("commandcode");
		expect(bundled?.baseUrl).toBe("https://api.commandcode.ai");
		expect(bundled?.maxTokens).toBe(200_000);
		const bundledCodex = getBundledModel("commandcode", "gpt-5.3-codex");
		expect(bundledCodex?.name).toBe("GPT-5.3 Codex (Command Code)");
		expect(bundledCodex?.contextWindow).toBe(272_000);
		expect(COMMAND_CODE_MODELS.find(model => model.id === "gpt-5.3-codex")?.contextWindow).toBe(272_000);
		expect(COMMAND_CODE_MODELS.length).toBeGreaterThan(0);
	});

	it("serializes requests and consumes a final unterminated finish event", async () => {
		const model = COMMAND_CODE_MODELS.find(item => item.id === "deepseek/deepseek-v4-flash") as Model<"commandcode">;
		let requestBody: Record<string, unknown> | undefined;
		const authHeaders: Array<string | null> = [];
		const context: Context = {
			systemPrompt: ["system one", "system two"],
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			tools: [],
		};
		const stream = streamCommandCode(model, context, {
			apiKey: "test-key",
			maxTokens: 123,
			sessionId: "session-test",
			fetch: async (_input, init) => {
				authHeaders.push(new Headers(init?.headers).get("Authorization"));
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return ndjsonResponse(
					[
						{ type: "reasoning-delta", text: "thought" },
						{ type: "reasoning-end" },
						{ type: "text-delta", text: "answer" },
						{
							type: "finish",
							finishReason: "stop",
							totalUsage: {
								inputTokens: 10,
								outputTokens: 4,
								inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 1 },
							},
						},
					],
					false,
				);
			},
		});

		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(authHeaders[0]).toBe("Bearer test-key");
		const params = requestBody?.params as Record<string, unknown> | undefined;
		expect(params?.model).toBe("deepseek/deepseek-v4-flash");
		expect(params?.system).toBe("system one\n\nsystem two");
		expect(params?.max_tokens).toBe(123);
		expect(events.map(event => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.content.map(content => content.type)).toEqual(["thinking", "text"]);
		expect(result.usage.totalTokens).toBe(17);
	});

	it("uses the bundled model output limit when maxTokens is not overridden", async () => {
		const model = COMMAND_CODE_MODELS.find(item => item.id === "deepseek/deepseek-v4-flash") as Model<"commandcode">;
		let requestBody: Record<string, unknown> | undefined;
		const stream = streamCommandCode(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }], tools: [] },
			{
				apiKey: "test-key",
				fetch: async (_input, init) => {
					requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return ndjsonResponse([{ type: "finish", finishReason: "stop" }]);
				},
			},
		);

		await stream.result();

		const params = requestBody?.params as Record<string, unknown> | undefined;
		expect(params?.max_tokens).toBe(200_000);
	});

	it("translates Command Code tool calls and finish reason", async () => {
		const model = COMMAND_CODE_MODELS[0] as Model<"commandcode">;
		const stream = streamCommandCode(
			model,
			{ messages: [], tools: [] },
			{
				apiKey: "test-key",
				fetch: async () =>
					ndjsonResponse([
						{ type: "tool-call", toolCallId: "call-1", toolName: "read", input: '{"path":"x"}' },
						{ type: "finish", finishReason: "tool-calls" },
					]),
			},
		);

		const result = await stream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "x" },
		});
	});
});
