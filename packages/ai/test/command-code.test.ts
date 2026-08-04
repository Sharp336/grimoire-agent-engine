import { afterEach, describe, expect, it } from "bun:test";
import {
	buildCommandCodeServerConfig,
	clearCommandCodeServerConfigCache,
	coerceToolArguments,
	slugifyProjectPath,
	streamCommandCode,
} from "@oh-my-pi/pi-ai/providers/command-code";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
			if (req.method !== "POST" || url.pathname !== "/alpha/generate") {
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

	it("hoists tool-result images into a follow-up user turn", async () => {
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
