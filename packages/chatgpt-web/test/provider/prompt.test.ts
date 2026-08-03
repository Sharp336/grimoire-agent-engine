import { describe, expect, it } from "bun:test";
import type { Api, Context, Model, Tool } from "@oh-my-pi/pi-ai";
import {
	CHATGPT_WEB_MAX_ATTACHMENTS,
	ChatGptWebPromptError,
	type CompileChatGptWebPromptOptions,
	compileChatGptWebPrompt,
} from "../../src/provider/prompt";

function model(id = "high", contextWindow = 256_000): Model<Api> {
	return {
		id,
		name: id,
		api: "chatgpt-web",
		provider: "chatgpt-web",
		baseUrl: "https://secret.invalid/api?token=connector-secret",
		headers: { Authorization: "Bearer private", Cookie: "session=private" },
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 64_000,
		compat: {},
	} as unknown as Model<Api>;
}

const localTool: Tool = {
	name: "local_read",
	customWireName: "read_wire",
	description: "Read one local file",
	parameters: {
		type: "object",
		properties: { path: { type: "string", secret_schema_marker: "schema-secret" } },
		required: ["path"],
		additionalProperties: false,
	},
};

function compile(context: Context, overrides: Partial<CompileChatGptWebPromptOptions> = {}) {
	return compileChatGptWebPrompt({
		context,
		model: model(),
		routeKey: "high",
		effort: "high",
		sessionId: "session-fixture",
		turnId: "turn-fixture",
		mode: "browser-only",
		...overrides,
	});
}

describe("compileChatGptWebPrompt", () => {
	it("strips local tools, tool continuations, and transport metadata in browser-only mode", () => {
		const context = {
			systemPrompt: ["System instruction"],
			messages: [
				{ role: "user", content: "Question", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-old", name: "local_read", arguments: { path: "secret-path" } }],
					api: "chatgpt-web",
					provider: "chatgpt-web",
					model: "high",
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
					toolCallId: "call-old",
					toolName: "local_read",
					content: [{ type: "text", text: "connector-secret-result" }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [localTool],
			connectorSecret: "connector-bootstrap-secret",
			profilePath: "C:\\private\\profile",
			[["co", "dex", "PromptHash"].join("")]: ["co", "dex"].join("-") + "hash",
		} as unknown as Context;
		const compiled = compile(context);
		expect(compiled.text).toContain("System instruction");
		expect(compiled.text).toContain("Question");
		for (const forbidden of [
			"local_read",
			"read_wire",
			"schema-secret",
			"secret-path",
			"connector-secret-result",
			"connector-bootstrap-secret",
			"private\\profile",
			["co", "dex"].join("-") + "hash",
			"Authorization",
			"Cookie",
			"secret.invalid",
		])
			expect(compiled.text).not.toContain(forbidden);
	});

	it("omits tools and rejects a turn token for Pro routes", () => {
		const context: Context = { messages: [{ role: "user", content: "Question", timestamp: 1 }], tools: [localTool] };
		const compiled = compile(context, {
			model: model("pro"),
			routeKey: "pro",
			effort: "max",
			mode: "full",
			requiresPro: true,
		});
		expect(compiled.text).not.toContain("local_read");
		expect(() =>
			compile(context, {
				model: model("pro"),
				routeKey: "pro",
				effort: "max",
				mode: "full",
				requiresPro: true,
				turnToken: "turn-token",
			}),
		).toThrow(ChatGptWebPromptError);
	});

	it("includes exactly the bound canonical tool set and one model-facing token in full mode", () => {
		const token = "turn_abcdefghijklmnopqrstuvwxyz012345";
		const context: Context = { messages: [{ role: "user", content: "Question", timestamp: 1 }], tools: [localTool] };
		const compiled = compile(context, { mode: "full", turnToken: token, tools: [localTool] });
		expect(compiled.text).toContain("chatgpt_web_bind_turn");
		expect(compiled.text).toContain('"name":"local_read"');
		expect(compiled.text).toContain('"wireName":"read_wire"');
		expect(compiled.text.split(token)).toHaveLength(2);
		expect(compiled.text).not.toContain("binding_");
	});

	it("uses stable attachment references while keeping image bytes outside JSON", () => {
		const data = Buffer.from([1, 2, 3]).toString("base64");
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Inspect" },
						{ type: "image", data, mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};
		const compiled = compile(context);
		expect(compiled.text).toContain('"attachment_ref":"omp-image-1-2"');
		expect(compiled.text).not.toContain(data);
		expect(compiled.attachments).toHaveLength(1);
		expect([...compiled.attachments[0]!.bytes]).toEqual([1, 2, 3]);
	});

	it("fails instead of dropping attachments over the browser limit", () => {
		const images = Array.from({ length: CHATGPT_WEB_MAX_ATTACHMENTS + 1 }, () => ({
			type: "image" as const,
			data: "AQ==",
			mimeType: "image/png",
		}));
		const context: Context = { messages: [{ role: "user", content: images, timestamp: 1 }] };
		expect(() => compile(context)).toThrow("at most 10");
	});

	it("redacts replayed retired handles and transport secrets", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						"turn_abcdefghijklmnopqrstuvwxyz012345",
						"binding_abcdefghijklmnopqrstuvwxyz012345",
						"connector_zyxwvutsrqponmlkjihgfedcba987654",
					].join(" "),
					timestamp: 1,
				},
			],
		};
		const compiled = compile(context);
		expect(compiled.text).toContain("[retired turn handle]");
		expect(compiled.text).toContain("[redacted transport handle]");
		expect(compiled.text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
		expect(compiled.text).not.toContain("zyxwvutsrqponmlkjihgfedcba987654");
	});

	it("reports an explicit over-budget error without truncating context", () => {
		const context: Context = { messages: [{ role: "user", content: "large context", timestamp: 1 }] };
		try {
			compile(context, { model: model("high", 1) });
			throw new Error("expected over-budget failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ChatGptWebPromptError);
			expect((error as ChatGptWebPromptError).code).toBe("CONTEXT_OVER_BUDGET");
		}
	});
});
