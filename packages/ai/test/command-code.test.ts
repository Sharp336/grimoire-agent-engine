import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
	buildCommandCodeServerConfig,
	clearCommandCodeServerConfigCache,
	coerceToolArguments,
	slugifyProjectPath,
	streamCommandCode,
} from "@oh-my-pi/pi-ai/providers/command-code";
import { NO_AUTH_SENTINEL } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { COMMAND_CODE_TEXT_FRAMES, COMMAND_CODE_TOOL_CALL_FRAMES } from "./fixtures/command-code-stream";

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

/**
 * Header and envelope shape observed on a live `POST /alpha/generate` from the
 * official Command Code CLI v1.9.0. The provider must stay byte-compatible
 * with this — see `command-code-stream.ts` for the response side.
 */
const OFFICIAL_CLIENT_HEADERS = {
	"user-agent": "cli",
	"x-cli-environment": "production",
	"x-co-flag": "false",
	"x-command-code-version": "1.9.0",
	"x-taste-learning": "false",
} as const;
const OFFICIAL_ENVELOPE_KEYS = ["config", "memory", "taste", "skills", "permissionMode", "threadId", "params"];
const OFFICIAL_PARAMS_KEYS = ["model", "messages", "tools", "system", "max_tokens", "stream"];

let server: Bun.Server<unknown> | undefined;
let scenario:
	| { kind: "capture"; body: string }
	| { kind: "happy" }
	| { kind: "provider-executed" }
	| { kind: "provider-executed-interleaved" }
	| { kind: "malformed-line" }
	| { kind: "truncated" }
	| { kind: "frames"; lines: readonly string[] }
	| { kind: "gateway-error"; error: unknown }
	| { kind: "pause-turn" } = { kind: "happy" };
let lastRequest: CapturedRequest | undefined;
let requestCount = 0;

function makeModel(baseUrl: string): Model<"command-code"> {
	return buildModel({
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "command-code",
		provider: "command-code",
		baseUrl,
		reasoning: true,
		input: ["text"],
		// Live gateway rates, in USD per million tokens.
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
	});
}

function makeVisionModel(baseUrl: string): Model<"command-code"> {
	return {
		...makeModel(baseUrl),
		id: "Qwen/Qwen3.7-Plus",
		name: "Qwen 3.7 Plus",
		input: ["text", "image"],
	};
}

function ndjson(lines: readonly string[]): Response {
	// The gateway advertises text/event-stream but writes bare NDJSON.
	return new Response(`${lines.join("\n")}\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

async function startServer(): Promise<string> {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			// Suffix match so a path-prefixed base (`{base}/cmd`) still routes here;
			// anything that is not the generate endpoint still 404s.
			if (req.method !== "POST" || !url.pathname.endsWith("/alpha/generate")) {
				return new Response("not found", { status: 404 });
			}
			const body = (await req.json()) as Record<string, unknown>;
			lastRequest = { url: req.url, headers: req.headers, body };
			requestCount++;

			if (scenario.kind === "capture") {
				return new Response(scenario.body, {
					headers: { "content-type": "application/x-ndjson" },
				});
			}
			if (scenario.kind === "frames") return ndjson(scenario.lines);
			if (scenario.kind === "gateway-error") {
				return ndjson([`{"type":"start"}`, JSON.stringify({ type: "error", error: scenario.error })]);
			}
			if (scenario.kind === "pause-turn") {
				// Two paused continuations, then a real finish.
				if (requestCount <= 2) {
					return ndjson([
						`{"type":"text-delta","text":"part${requestCount}"}`,
						`{"type":"finish","finishReason":"stop","rawFinishReason":"pause_turn","totalUsage":{"inputTokens":10,"outputTokens":2,"inputTokenDetails":{"noCacheTokens":10,"cacheReadTokens":0}}}`,
					]);
				}
				return ndjson([
					`{"type":"text-delta","text":"done"}`,
					`{"type":"finish","finishReason":"stop","rawFinishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":3,"inputTokenDetails":{"noCacheTokens":10,"cacheReadTokens":0}}}`,
				]);
			}
			if (scenario.kind === "happy") {
				return ndjson([
					`{"type":"reasoning-start"}`,
					`{"type":"reasoning-delta","text":"thinking"}`,
					`{"type":"reasoning-end"}`,
					`{"type":"text-delta","text":"Hello"}`,
					`{"type":"tool-call","toolCallId":"call_1","toolName":"read","input":{"path":"a.ts"}}`,
					`{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":5,"inputTokenDetails":{"cacheReadTokens":2,"cacheWriteTokens":1}}}`,
				]);
			}
			if (scenario.kind === "provider-executed") {
				return ndjson([
					`{"type":"tool-call","toolCallId":"srv_1","toolName":"web_search","input":{},"providerExecuted":true}`,
					`{"type":"tool-result","toolCallId":"srv_1","toolName":"web_search","result":"found it"}`,
					`{"type":"finish","finishReason":"stop"}`,
				]);
			}
			if (scenario.kind === "provider-executed-interleaved") {
				return ndjson([
					`{"type":"text-delta","text":"before "}`,
					`{"type":"tool-result","toolCallId":"srv_1","toolName":"web_search","result":"found it"}`,
					`{"type":"text-delta","text":"after"}`,
					`{"type":"finish","finishReason":"stop"}`,
				]);
			}
			if (scenario.kind === "malformed-line") {
				return ndjson([
					`{"type":"text-delta","text":"A"}`,
					`not json`,
					`{"type":"text-delta","text":"B"}`,
					`{"type":"finish","finishReason":"stop"}`,
				]);
			}
			// truncated
			return ndjson([`{"type":"text-delta","text":"partial"}`]);
		},
	});
	return `http://127.0.0.1:${server.port}`;
}

async function collectStream(
	model: Model<"command-code">,
	context: Context,
	options?: { conversationId?: string; sessionId?: string; cwd?: string; mode?: string },
) {
	const stream = streamCommandCode(model, context, {
		apiKey: "test-key",
		conversationId: options?.conversationId,
		sessionId: options?.sessionId,
		mode: options?.mode,
		// Only the tests that assert on `config` pay for the git/readdir probe;
		// the rest pin it to `null` so they stay hermetic.
		...(options?.cwd === undefined ? { config: null } : { cwd: options.cwd }),
	});
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
	}
	const result = await stream.result();
	return { eventTypes, result };
}

afterEach(() => {
	lastRequest = undefined;
	requestCount = 0;
	scenario = { kind: "happy" };
	clearCommandCodeServerConfigCache();
	server?.stop(true);
	server = undefined;
});

describe("command-code request parity", () => {
	it("sends the envelope and headers the official CLI sends", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const context: Context = {
			systemPrompt: ["You are helpful.", "Be brief."],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
		};
		const uuid = "123e4567-e89b-12d3-a456-426614174000";
		await collectStream(makeModel(baseUrl), context, { conversationId: uuid, cwd: process.cwd() });

		const headers = lastRequest!.headers;
		for (const [name, value] of Object.entries(OFFICIAL_CLIENT_HEADERS)) {
			expect(headers.get(name)).toBe(value);
		}
		expect(headers.get("x-project-slug")).toBe(slugifyProjectPath(process.cwd()));
		expect(headers.get("x-session-id")).toBeTruthy();
		expect(headers.get("authorization")).toBe("Bearer test-key");

		const body = lastRequest!.body;
		expect(Object.keys(body).sort()).toEqual([...OFFICIAL_ENVELOPE_KEYS].sort());
		expect(body.memory).toBeNull();
		expect(body.taste).toBeNull();
		expect(body.skills).toBeNull();
		expect(body.permissionMode).toBe("standard");
		expect(body.threadId).toBe(uuid);
		// The official CLI omits `mode` on the main agent loop.
		expect("mode" in body).toBe(false);

		const params = body.params as Record<string, unknown>;
		expect(Object.keys(params).sort()).toEqual([...OFFICIAL_PARAMS_KEYS].sort());
		expect(params.model).toBe("deepseek/deepseek-v4-flash");
		expect(params.stream).toBe(true);
		expect(params.max_tokens).toBe(64_000);
		expect(params.system).toBe("You are helpful.\n\nBe brief.");
		const tools = params.tools as Array<Record<string, unknown>>;
		expect(Object.keys(tools[0] ?? {}).sort()).toEqual(["description", "input_schema", "name"]);
		expect(tools[0]?.name).toBe("read");
	});

	it("omits threadId when the conversation id is not UUID-shaped", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		await collectStream(makeModel(baseUrl), context, { sessionId: "not-a-uuid" });
		expect(lastRequest!.body.threadId).toBeUndefined();
		// The header still carries the caller's id verbatim so the gateway sees a
		// stable session across turns.
		expect(lastRequest!.headers.get("x-session-id")).toBe("not-a-uuid");
	});

	it("sends a UUIDv7 session id as threadId", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		// oh-my-pi mints v7 ids; the gateway accepts them even though the official
		// CLI's own guard only matches v1-5.
		const v7 = "019fcd7a-c02f-7000-92c3-452b515a445f";
		await collectStream(makeModel(baseUrl), context, { sessionId: v7 });
		expect(lastRequest!.body.threadId).toBe(v7);
	});

	it("sends `mode` only when the caller asks for a side call", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		await collectStream(makeModel(baseUrl), context, { mode: "title-gen" });
		expect(lastRequest!.body.mode).toBe("title-gen");
	});

	it("replays tool results as role:tool messages before the next user turn", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: 2,
		};
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "let me look" },
						{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
					],
					api: "command-code",
					provider: "command-code",
					model: "deepseek/deepseek-v4-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				toolResult,
				{ role: "user", content: "continue", timestamp: 3 },
			],
		};
		await collectStream(makeModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		expect(params.messages.map(message => message.role)).toEqual(["assistant", "tool", "user"]);
		const assistant = params.messages[0] as { content: Array<Record<string, unknown>> };
		expect(assistant.content).toEqual([
			{ type: "reasoning", text: "let me look" },
			{ type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } },
		]);
		const toolMessage = params.messages[1] as { content: Array<Record<string, unknown>> };
		// `toolName` is empty on purpose: the official client leaves it blank and
		// the gateway matches results to calls by `toolCallId`.
		expect(toolMessage.content[0]).toEqual({
			type: "tool-result",
			toolCallId: "call_1",
			toolName: "",
			output: { type: "text", value: "file contents" },
		});
	});

	it("serializes failed tool results as error-text output", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "ENOENT: no such file" }],
			isError: true,
			timestamp: 2,
		};
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "missing.ts" } }],
					api: "command-code",
					provider: "command-code",
					model: "deepseek/deepseek-v4-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				toolResult,
				{ role: "user", content: "continue", timestamp: 3 },
			],
		};
		await collectStream(makeModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		const toolMessage = params.messages[1] as { content: Array<Record<string, unknown>> };
		expect(toolMessage.content[0]).toEqual({
			type: "tool-result",
			toolCallId: "call_1",
			toolName: "",
			output: { type: "error-text", value: "ENOENT: no such file" },
		});
	});

	it("sends requestModelId as the wire model id", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const aliased = {
			...makeModel(baseUrl),
			id: "command-code/local-alias",
			requestModelId: "deepseek/deepseek-v4-flash",
		} as Model<"command-code">;
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(aliased, context);
		const params = lastRequest!.body.params as { model: string };
		expect(params.model).toBe("deepseek/deepseek-v4-flash");
		// Local attribution keeps the catalog id.
		expect(result.model).toBe("command-code/local-alias");
	});

	it("hoists tool-result images into a follow-up user turn for vision models", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_img",
			toolName: "read",
			content: [
				{ type: "text", text: "screenshot captured" },
				{ type: "image", mimeType: "image/png", data: "AAEC" },
			],
			isError: false,
			timestamp: 2,
		};
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "shot.png" } }],
					api: "command-code",
					provider: "command-code",
					model: "Qwen/Qwen3.7-Plus",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				toolResult,
				{ role: "user", content: "describe it", timestamp: 3 },
			],
		};
		await collectStream(makeVisionModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		expect(params.messages.map(message => message.role)).toEqual(["assistant", "tool", "user", "user"]);
		const toolMessage = params.messages[1] as { content: Array<Record<string, unknown>> };
		expect(toolMessage.content[0]).toEqual({
			type: "tool-result",
			toolCallId: "call_img",
			toolName: "",
			output: { type: "text", value: "screenshot captured" },
		});
		const hoist = params.messages[2] as { content: Array<Record<string, unknown>> };
		expect(hoist.content).toEqual([
			{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
			{ type: "image", image: "data:image/png;base64,AAEC", mimeType: "image/png" },
		]);
	});

	it("buffers hoisted images until after consecutive tool results", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.png" } },
						{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.txt" } },
					],
					api: "command-code",
					provider: "command-code",
					model: "Qwen/Qwen3.7-Plus",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_a",
					toolName: "read",
					content: [
						{ type: "text", text: "image a" },
						{ type: "image", mimeType: "image/png", data: "AAAA" },
					],
					isError: false,
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_b",
					toolName: "read",
					content: [{ type: "text", text: "plain b" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "compare", timestamp: 4 },
			],
		};
		await collectStream(makeVisionModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		// Contiguous tool window first, then a single hoist turn.
		expect(params.messages.map(message => message.role)).toEqual(["assistant", "tool", "tool", "user", "user"]);
		const hoist = params.messages[3] as { content: Array<Record<string, unknown>> };
		expect(hoist.content).toEqual([
			{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
			{ type: "image", image: "data:image/png;base64,AAAA", mimeType: "image/png" },
		]);
	});

	it("omits tool-result images for text-only models", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_img",
			toolName: "read",
			content: [
				{ type: "text", text: "screenshot captured" },
				{ type: "image", mimeType: "image/png", data: "AAEC" },
			],
			isError: false,
			timestamp: 2,
		};
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "shot.png" } }],
					api: "command-code",
					provider: "command-code",
					model: "deepseek/deepseek-v4-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				toolResult,
				{ role: "user", content: "describe it", timestamp: 3 },
			],
		};
		await collectStream(makeModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		expect(params.messages.map(message => message.role)).toEqual(["assistant", "tool", "user"]);
		const toolMessage = params.messages[1] as { content: Array<Record<string, unknown>> };
		expect(toolMessage.content[0]).toEqual({
			type: "tool-result",
			toolCallId: "call_img",
			toolName: "",
			output: {
				type: "text",
				value: `screenshot captured\n${NON_VISION_IMAGE_PLACEHOLDER}`,
			},
		});
		expect(JSON.stringify(params.messages)).not.toContain('"type":"image"');
	});

	it("replaces user images with a placeholder on text-only models", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image", mimeType: "image/png", data: "AAEC" },
					],
					timestamp: 1,
				},
			],
		};
		await collectStream(makeModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		const userMessage = params.messages[0] as { content: Array<Record<string, unknown>> };
		expect(userMessage.content).toEqual([
			{ type: "text", text: "what is this?" },
			{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
		]);
	});

	it("preserves interleaved text/image order in user content", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "caption above" },
						{ type: "image", mimeType: "image/png", data: "AAEC" },
						{ type: "text", text: "caption below" },
					],
					timestamp: 1,
				},
			],
		};
		await collectStream(makeVisionModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		const userMessage = params.messages[0] as { content: Array<Record<string, unknown>> };
		// Interleaved blocks must stay in original order, not text-then-image.
		expect(userMessage.content).toEqual([
			{ type: "text", text: "caption above" },
			{ type: "image", image: "data:image/png;base64,AAEC", mimeType: "image/png" },
			{ type: "text", text: "caption below" },
		]);
	});

	it("keeps the placeholder in place on text-only models", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n`,
		};
		const baseUrl = await startServer();
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "caption above" },
						{ type: "image", mimeType: "image/png", data: "AAEC" },
						{ type: "text", text: "caption below" },
					],
					timestamp: 1,
				},
			],
		};
		await collectStream(makeModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		const userMessage = params.messages[0] as { content: Array<Record<string, unknown>> };
		expect(userMessage.content).toEqual([
			{ type: "text", text: "caption above" },
			{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
			{ type: "text", text: "caption below" },
		]);
	});

	it("advertises customWireName as the wire tool name", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{
					name: "edit",
					description: "Apply a patch",
					parameters: { type: "object", properties: { file: { type: "string" } } },
					customWireName: "apply_patch",
				},
			],
		};
		await collectStream(makeModel(baseUrl), context);
		const params = lastRequest!.body.params as { tools: Array<Record<string, unknown>> };
		// The model must see the name it was trained on (apply_patch), not the
		// harness-internal name (edit).
		expect(params.tools[0]?.name).toBe("apply_patch");
	});

	it("replays assistant tool calls under the advertised wire alias", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_patch", name: "edit", arguments: { file: "a.ts" } }],
					api: "command-code",
					provider: "command-code",
					model: "deepseek/deepseek-v4-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						totalTokens: 0,
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_patch",
					toolName: "edit",
					content: [{ type: "text", text: "patched" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "continue", timestamp: 3 },
			],
			tools: [
				{
					name: "edit",
					description: "Apply a patch",
					parameters: { type: "object", properties: { file: { type: "string" } } },
					customWireName: "apply_patch",
				},
			],
		};
		await collectStream(makeModel(baseUrl), context);
		const params = lastRequest!.body.params as { messages: Array<Record<string, unknown>> };
		const assistantMessage = params.messages[0] as { content: Array<Record<string, unknown>> };
		expect(assistantMessage.content[0]).toEqual({
			type: "tool-call",
			toolCallId: "call_patch",
			toolName: "apply_patch",
			input: { file: "a.ts" },
		});
	});
});

describe("command-code stream handling", () => {
	it("consumes the captured tool-call stream", async () => {
		scenario = { kind: "frames", lines: COMMAND_CODE_TOOL_CALL_FRAMES };
		const baseUrl = await startServer();
		const model = makeModel(baseUrl);
		const context: Context = { messages: [{ role: "user", content: "read it", timestamp: 1 }] };
		const { eventTypes, result } = await collectStream(model, context);

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Let me read the file answer.ts in the working directory." },
			{
				type: "toolCall",
				id: "call_00_TLsr3b3xZH3UeR5oqBZp6075",
				name: "read_file",
				arguments: { file_path: "/repo/answer.ts" },
			},
		]);
		// Arguments stream in through tool-input-delta before the authoritative
		// tool-call frame lands.
		expect(eventTypes.filter(type => type === "toolcall_delta").length).toBeGreaterThan(0);
		expect(eventTypes.at(0)).toBe("start");
		expect(eventTypes.at(-1)).toBe("done");

		// `inputTokens` is the billed prompt total and already contains the cached
		// portion; oh-my-pi bills `input` as the non-cached bucket only.
		expect(result.usage.input).toBe(21_901);
		expect(result.usage.cacheRead).toBe(7936);
		expect(result.usage.output).toBe(108);
		expect(result.usage.reasoningTokens).toBe(12);
		expect(result.usage.totalTokens).toBe(29_945);
	});

	it("consumes the captured text stream and prices it like the gateway", async () => {
		scenario = { kind: "frames", lines: COMMAND_CODE_TEXT_FRAMES };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);

		expect(result.stopReason).toBe("stop");
		expect(result.content.map(block => block.type)).toEqual(["thinking", "text"]);
		expect(result.usage.input).toBe(58);
		expect(result.usage.cacheRead).toBe(24_064);
		expect(result.usage.output).toBe(39);

		// The gateway reported 0.0000864192 USD for this exact turn; the catalog
		// rates must reproduce it.
		expect(result.usage.cost.total).toBeCloseTo(0.0000864192, 12);
	});

	it("streams thinking, text, and local tool calls", async () => {
		scenario = { kind: "happy" };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thinking" },
			{ type: "text", text: "Hello" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
		]);
		expect(result.usage.input).toBe(7);
		expect(result.usage.output).toBe(5);
		expect(result.usage.cacheRead).toBe(2);
		expect(result.usage.cacheWrite).toBe(1);
		expect(result.usage.totalTokens).toBe(15);
	});

	it("mirrors every NDJSON frame to the raw SSE observer", async () => {
		scenario = { kind: "happy" };
		const baseUrl = await startServer();
		const model = makeModel(baseUrl);
		const observed: Array<{ event: string | null; data: string }> = [];
		const stream = streamCommandCode(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "test-key",
				config: null,
				onSseEvent: event => {
					observed.push({ event: event.event, data: event.data });
				},
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		// `happy` serves six frames; every one must reach the observer, with the
		// frame `type` surfaced as the SSE `event` and the raw line as `data`.
		expect(observed.map(frame => frame.event)).toEqual([
			"reasoning-start",
			"reasoning-delta",
			"reasoning-end",
			"text-delta",
			"tool-call",
			"finish",
		]);
		expect(observed[5]?.data).toBe(
			`{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":5,"inputTokenDetails":{"cacheReadTokens":2,"cacheWriteTokens":1}}}`,
		);
	});

	it("maps inbound tool-call wire names back to local names with the alias preserved", async () => {
		scenario = {
			kind: "frames",
			lines: [
				`{"type":"tool-call","toolCallId":"call_patch","toolName":"apply_patch","input":{"file":"a.ts"}}`,
				`{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":5,"inputTokenDetails":{}}}`,
			],
		};
		const baseUrl = await startServer();
		const context: Context = {
			messages: [{ role: "user", content: "patch a.ts", timestamp: 1 }],
			tools: [
				{
					name: "edit",
					description: "Apply a patch",
					parameters: { type: "object", properties: { file: { type: "string" } } },
					customWireName: "apply_patch",
				},
			],
		};
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("toolUse");
		// The dispatcher matches `name`; the wire alias rides along for replay.
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_patch",
				name: "edit",
				customWireName: "apply_patch",
				arguments: { file: "a.ts" },
			},
		]);
	});

	it("re-sends the request while the gateway asks to pause the turn", async () => {
		scenario = { kind: "pause-turn" };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(requestCount).toBe(3);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "part1part2done" }]);
		// Usage accumulates across continuations.
		expect(result.usage.input).toBe(30);
		expect(result.usage.output).toBe(7);
	});

	it("keeps provider-executed calls non-runnable", async () => {
		scenario = { kind: "provider-executed" };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "search", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("stop");
		expect(result.content.some(block => block.type === "toolCall")).toBe(false);
		const text = result.content.find(block => block.type === "text");
		expect(text?.type === "text" ? text.text : "").toContain("found it");
	});

	it("keeps text ordered around a provider-executed tool result", async () => {
		scenario = { kind: "provider-executed-interleaved" };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "search", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		// The open text block must be closed before the tool-result block, so the
		// trailing delta lands in a new block instead of flowing back into "before ".
		expect(result.content.map(block => (block.type === "text" ? block.text : block.type))).toEqual([
			"before ",
			"[web_search] found it",
			"after",
		]);
	});

	it("tolerates malformed stream lines", async () => {
		scenario = { kind: "malformed-line" };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "AB" }]);
	});

	it("errors when the stream ends before finish", async () => {
		scenario = { kind: "truncated" };
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/ended before finish/i);
	});

	it("surfaces the gateway's error frame with its type, so retries can classify it", async () => {
		// Exactly the frame a stalled upstream produced against the live gateway.
		scenario = {
			kind: "gateway-error",
			error: { type: "server_error", message: "Network connection lost." },
		};
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toContain("type=server_error");
		expect(result.errorMessage ?? "").toContain("Network connection lost.");
	});

	it("maps a retryable error frame onto a transient status", async () => {
		scenario = {
			kind: "gateway-error",
			error: { type: "rate_limit_error", message: "slow down", statusCode: 429, isRetryable: true },
		};
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	it("promotes a retryable frame with a non-retryable 4xx status to 503", async () => {
		// The shared classifier rejects most 4xx statuses before reading the
		// frame type, so a provider-marked-transient 400 must be lifted to a
		// transient status the retry layer will actually retry.
		scenario = {
			kind: "gateway-error",
			error: { type: "server_error", message: "try again", statusCode: 400, isRetryable: true },
		};
		const baseUrl = await startServer();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const { result } = await collectStream(makeModel(baseUrl), context);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
	});
});

describe("command-code helpers", () => {
	it("slugifies a working directory the way the CLI does", () => {
		expect(
			slugifyProjectPath(
				"/tmp/claude-1000/-home-diogo-dev-oh-my-pi/c4b6ef47-bfe2-4aca-9e6a-5acee94cb277/scratchpad/probe-repo",
			),
		).toBe("tmp-claude-1000-home-diogo-dev-oh-my-pi-c4b6ef47-bfe2-4aca-9e6a-5acee94cb277-scratchpad-probe-repo");
		expect(slugifyProjectPath("/home/user/MyProject")).toBe("home-user-my-project");
		expect(slugifyProjectPath("/")).toBe("root");
	});

	it("recovers tool arguments from the shapes the gateway emits", () => {
		expect(coerceToolArguments({ path: "a.ts" })).toEqual({ path: "a.ts" });
		expect(coerceToolArguments(`{"path":"a.ts"}`)).toEqual({ path: "a.ts" });
		expect(coerceToolArguments([{ path: "a.ts" }])).toEqual({ path: "a.ts" });
		expect(coerceToolArguments("")).toEqual({});
		expect(coerceToolArguments("not json")).toEqual({});
	});

	it("builds the repository snapshot the envelope's config carries", async () => {
		const config = await buildCommandCodeServerConfig(process.cwd());
		expect(config.workingDir).toBe(process.cwd());
		expect(config.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(config.environment).toBe(process.platform);
		expect(Array.isArray(config.structure)).toBe(true);
		expect(config.structure).not.toContain("node_modules");
		// Environment-stable invariants only: PR CI checks out a detached HEAD
		// (`git branch --show-current` → ""), and a clean tree has empty status.
		expect(config.isGitRepo).toBe(true);
		expect(typeof config.currentBranch).toBe("string");
		expect(typeof config.gitStatus).toBe("string");
		expect(config.mainBranch.length).toBeGreaterThan(0);
		expect(config.recentCommits.length).toBeGreaterThan(0);
	});

	it("preserves a git status that exceeds the probe byte cap", async () => {
		// A dirty repo whose `git status --porcelain` blows past the 64 KiB probe
		// cap: git exits with SIGPIPE (141) when stdout is cancelled, and the
		// capped output must still land in the snapshot rather than regressing to
		// "Working tree clean". Untracked directories collapse to one line, so the
		// probe must be exercised with tracked-and-modified files.
		await using dir = await TempDir.create("command-code-git-cap");
		const path = dir.path();
		await fs.mkdir(`${path}/dirty`);
		// ~20 bytes × 6k files ≈ 110 KiB of modified status, past the 64 KiB cap.
		const writes = Array.from({ length: 6_000 }, (_, i) => fs.writeFile(`${path}/dirty/f-${i}.txt`, "x"));
		await Promise.all(writes);

		const identity = ["-c", "user.email=test@omp", "-c", "user.name=test"];
		const init = Bun.spawnSync(["git", "init", path]);
		expect(init.exitCode).toBe(0);
		const add = Bun.spawnSync(["git", ...identity, "-C", path, "add", "dirty"]);
		expect(add.exitCode).toBe(0);
		const commit = Bun.spawnSync(["git", ...identity, "-C", path, "commit", "-qm", "init"]);
		expect(commit.exitCode).toBe(0);
		// Touch every tracked file so the working tree is dirty.
		const dirty = Array.from({ length: 6_000 }, (_, i) => fs.appendFile(`${path}/dirty/f-${i}.txt`, "y"));
		await Promise.all(dirty);

		clearCommandCodeServerConfigCache();
		const config = await buildCommandCodeServerConfig(path);
		expect(config.isGitRepo).toBe(true);
		expect(config.gitStatus).not.toBe("Working tree clean");
		expect(config.gitStatus.length).toBeGreaterThan(0);
		// The cap still holds on the wire: never the full untruncated status
		// (~110 KiB). Sanity bounds it to the probe cap and a little slack.
		expect(config.gitStatus.length).toBeLessThan(100_000);
	});
});

describe("command-code streamSimple options", () => {
	it("forwards cwd into the Command Code config snapshot", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		const cwd = process.cwd();
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "test-key",
				cwd,
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();
		const config = lastRequest!.body.config as { workingDir?: string };
		expect(config.workingDir).toBe(cwd);
		expect(lastRequest!.headers.get("x-project-slug")).toBe(slugifyProjectPath(cwd));
	});

	it("omits params.tools when toolChoice is none", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"finish","finishReason":"stop"}
`,
		};
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "none",
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		const params = lastRequest!.body.params as Record<string, unknown>;
		expect(params.tools).toBeUndefined();
	});

	it("narrows params.tools to the named toolChoice tool", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
					{
						name: "write",
						description: "Write a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: { type: "function", name: "write" },
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		const params = lastRequest!.body.params as Record<string, unknown>;
		const tools = params.tools as Array<{ name: string }>;
		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("write");
	});

	it("rejects toolChoice required because the gateway has no force field", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "required",
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/toolChoice "required"\/"any" is unsupported/i);
		expect(lastRequest).toBeUndefined();
	});

	it("rejects toolChoice any because the gateway has no force field", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "any",
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/toolChoice "required"\/"any" is unsupported/i);
		expect(lastRequest).toBeUndefined();
	});

	it("keeps a path-prefixed base URL when resolving the generate endpoint", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl: `${baseUrl}/cmd`,
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "test-key" },
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		expect(new URL(lastRequest!.url).pathname).toBe("/cmd/alpha/generate");
	});

	it("lets onPayload observe and replace the request body", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		let seen: Record<string, unknown> | undefined;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "test-key",
				onPayload: payload => {
					seen = payload as Record<string, unknown>;
					return { ...(payload as Record<string, unknown>), permissionMode: "plan" };
				},
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		// The hook sees the real envelope...
		expect((seen!.params as Record<string, unknown>).model).toBe("deepseek/deepseek-v4-flash");
		// ...and its replacement is what actually goes on the wire.
		expect(lastRequest!.body.permissionMode).toBe("plan");
	});

	it("notifies onResponse with the provider response", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		let responseStatus: number | undefined;
		let responseHeaders: Record<string, string> | undefined;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "test-key",
				onResponse: response => {
					responseStatus = response.status;
					responseHeaders = response.headers;
				},
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		expect(responseStatus).toBe(200);
		// The capture server answers with content-type application/x-ndjson.
		expect(responseHeaders?.["content-type"]).toBe("application/x-ndjson");
	});

	it("merges model headers under caller headers", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"finish","finishReason":"stop"}
`,
		};
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
			headers: { "x-model-header": "model-value", "x-overridden": "model" },
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "test-key",
				headers: { "x-overridden": "caller" },
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		expect(lastRequest!.headers.get("x-model-header")).toBe("model-value");
		expect(lastRequest!.headers.get("x-overridden")).toBe("caller");
	});

	it("omits Authorization for the keyless N/A sentinel", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"finish","finishReason":"stop"}
`,
		};
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: NO_AUTH_SENTINEL },
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		expect(lastRequest!.headers.has("authorization")).toBe(false);
	});

	it("keeps a single model Authorization without joining a default bearer", async () => {
		scenario = {
			kind: "capture",
			body: `{"type":"finish","finishReason":"stop"}
`,
		};
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
			headers: { Authorization: "Bearer proxy-key" },
		} as Model<"command-code">;
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "test-key" },
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		expect(lastRequest!.headers.get("authorization")).toBe("Bearer proxy-key");
	});
});
describe("command-code effort dial", () => {
	it("omits reasoning_effort for unladdered bundled reasoners under a global setting", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "Qwen/Qwen3.7-Plus"),
			baseUrl,
		} as Model<"command-code">;
		expect(model.thinking).toBeUndefined();

		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "test-key",
				reasoning: Effort.High,
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		const params = lastRequest!.body.params as Record<string, unknown>;
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("sends reasoning_effort for authored Command Code ladders", async () => {
		scenario = { kind: "capture", body: `{"type":"finish","finishReason":"stop"}\n` };
		const baseUrl = await startServer();
		const model = {
			...getBundledModel("command-code", "deepseek/deepseek-v4-flash"),
			baseUrl,
		} as Model<"command-code">;
		expect(model.thinking?.efforts).toEqual([Effort.High, Effort.Max]);

		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "test-key",
				reasoning: Effort.High,
			},
		);
		for await (const _ of stream) {
			/* drain */
		}
		await stream.result();

		const params = lastRequest!.body.params as Record<string, unknown>;
		expect(params.reasoning_effort).toBe("high");
	});
});
