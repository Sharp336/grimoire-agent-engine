import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	clearCustomApis,
	registerCustomApi,
	SqliteAuthCredentialStore,
	startAuthGateway,
} from "@oh-my-pi/pi-ai";
import { encodeStream, formatError, parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStreamType {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStreamType;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseLine(line: string): unknown {
	const stripped = line.replace(/^data: /, "");
	if (stripped === "[DONE]") return "[DONE]";
	return JSON.parse(stripped);
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

afterEach(() => {
	clearCustomApis();
});

describe("pi-native parseRequest", () => {
	it("accepts modelId + context and returns canonical shape", () => {
		const parsed = parseRequest({
			modelId: "claude-sonnet-4-5",
			context: baseContext,
			options: { temperature: 0.5, reasoning: Effort.High },
			stream: false,
		});
		expect(parsed.modelId).toBe("claude-sonnet-4-5");
		expect(parsed.context).toEqual(baseContext);
		expect(parsed.options.temperature).toBe(0.5);
		expect(parsed.options.reasoning).toBe(Effort.High);
		expect(parsed.stream).toBe(false);
	});

	it("falls back to model.id when modelId is absent (streamProxy compat)", () => {
		const parsed = parseRequest({
			model: { id: "claude-opus-4-1", provider: "anthropic", api: "anthropic-messages" },
			context: baseContext,
		});
		expect(parsed.modelId).toBe("claude-opus-4-1");
	});

	it("accepts top-level string `model` as the id (extra compat)", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			context: baseContext,
		});
		expect(parsed.modelId).toBe("gpt-5");
	});

	it("defaults stream to true when omitted", () => {
		const parsed = parseRequest({ modelId: "x", context: baseContext });
		expect(parsed.stream).toBe(true);
	});

	it("drops server-controlled and unknown option keys", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				temperature: 0.2,
				apiKey: "should-be-stripped",
				signal: {},
				fetch: () => {},
				onPayload: () => {},
				onResponse: () => {},
				onSseEvent: () => {},
				execHandlers: {},
				providerSessionState: new Map(),
				notARealField: "ignored",
			},
		});
		expect(parsed.options).toEqual({ temperature: 0.2 });
		expect("apiKey" in parsed.options).toBe(false);
		expect("signal" in parsed.options).toBe(false);
		expect("fetch" in parsed.options).toBe(false);
		expect("onPayload" in parsed.options).toBe(false);
		expect("notARealField" in parsed.options).toBe(false);
	});

	it("preserves headers, metadata, sessionId, thinkingBudgets", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				headers: { "x-foo": "bar" },
				metadata: { user_id: "u" },
				sessionId: "explicit-session",
				thinkingBudgets: { high: 8192 },
				stopSequences: ["\n\n"],
				toolChoice: "required",
				serviceTier: "priority",
				cacheRetention: "long",
			},
		});
		expect(parsed.options.headers).toEqual({ "x-foo": "bar" });
		expect(parsed.options.metadata).toEqual({ user_id: "u" });
		expect(parsed.options.sessionId).toBe("explicit-session");
		expect(parsed.options.thinkingBudgets).toEqual({ high: 8192 });
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.serviceTier).toBe("priority");
		expect(parsed.options.cacheRetention).toBe("long");
	});

	it("rejects missing required fields", () => {
		expect(() => parseRequest({ context: baseContext })).toThrow(/modelId/);
		expect(() => parseRequest({ modelId: "x" })).toThrow(/context/);
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: [] } })).toThrow(/messages/);
	});

	it("rejects non-object body", () => {
		expect(() => parseRequest(null)).toThrow();
		expect(() => parseRequest("hello")).toThrow();
		expect(() => parseRequest([])).toThrow();
	});

	it("validates systemPrompt and tools shape", () => {
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: "not array", messages: [] } })).toThrow(
			/systemPrompt/,
		);
		expect(() => parseRequest({ modelId: "x", context: { messages: [], tools: "not array" } })).toThrow(/tools/);
	});

	it("skips null and undefined option values", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { temperature: null, topP: undefined, maxTokens: 100 },
		});
		expect("temperature" in parsed.options).toBe(false);
		expect("topP" in parsed.options).toBe(false);
		expect(parsed.options.maxTokens).toBe(100);
	});
});
describe("pi-native encodeStream", () => {
	it("ships every AssistantMessageEvent verbatim, terminated by [DONE]", async () => {
		// Pi-native is omp-talks-to-omp: the client feeds parsed events directly
		// into `AssistantMessageEventStream.push()`, so the wire IS the canonical
		// event type. No partial-stripping, no per-event re-shaping.
		const finalMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: { ...ZERO_USAGE, input: 4, output: 2, totalTokens: 6 },
		});
		const partialAfterDelta: AssistantMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
		});
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_start", contentIndex: 0, partial: baseAssistant({ content: [{ type: "text", text: "" }] }) },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial: partialAfterDelta },
			{ type: "text_end", contentIndex: 0, content: "hi", partial: partialAfterDelta },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const chunks = await collectSse(encodeStream(makeEventStream(events, finalMessage)));
		const parsed = chunks.map(parseSseLine);

		// Every payload is the input event verbatim — partials, signatures,
		// usage all intact. Terminator follows `done`/`error`.
		expect(parsed.length).toBe(events.length + 1);
		for (let i = 0; i < events.length; i++) {
			expect(parsed[i]).toEqual(JSON.parse(JSON.stringify(events[i])));
		}
		expect(parsed[parsed.length - 1]).toBe("[DONE]");
	});

	it("preserves the rolling `partial` on every delta (sanity: no shrink)", async () => {
		// Guards against an accidental re-introduction of partial-stripping
		// optimization. Clients depend on `partial` being present.
		const final = baseAssistant({ content: [{ type: "text", text: "abc" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "abc", partial: final },
			{ type: "done", reason: "stop", message: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine) as Array<
			Record<string, unknown>
		>;
		expect(parsed[0]).toHaveProperty("partial");
		expect((parsed[0] as { partial: AssistantMessage }).partial.content).toEqual([{ type: "text", text: "abc" }]);
	});

	it("stops streaming after a terminal `done` and emits [DONE] once", async () => {
		const final = baseAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "done", reason: "stop", message: final },
			// This trailing event must NOT reach the wire — terminal events end
			// the stream so the client iterator resolves cleanly.
			{ type: "text_delta", contentIndex: 0, delta: "ghost", partial: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine);
		expect(parsed.length).toBe(2);
		expect((parsed[0] as { type: string }).type).toBe("done");
		expect(parsed[1]).toBe("[DONE]");
	});

	it("forwards `error` events verbatim, then closes with [DONE]", async () => {
		const errored = baseAssistant({
			stopReason: "error",
			errorMessage: "upstream blew up",
			usage: { ...ZERO_USAGE, input: 3 },
		});
		const events: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, errored)))).map(parseSseLine);
		expect(parsed[0]).toEqual({ type: "error", reason: "error", error: JSON.parse(JSON.stringify(errored)) });
		expect(parsed[1]).toBe("[DONE]");
	});

	it("emits a synthetic error envelope when the source iterator throws", async () => {
		// Source-stream failures (network drop after `streamSimple` returned)
		// must not hang the client. We surface a minimal `error` event followed
		// by `[DONE]` so the iterator on the other end resolves.
		const broken = (async function* () {
			yield { type: "start", partial: baseAssistant() } satisfies AssistantMessageEvent;
			throw new Error("connection reset");
		})() as unknown as AssistantMessageEventStream;
		(broken as { result(): Promise<AssistantMessage> }).result = async () => baseAssistant();

		const parsed = (await collectSse(encodeStream(broken))).map(parseSseLine);
		expect((parsed[0] as { type: string }).type).toBe("start");
		expect(parsed[1]).toEqual({ type: "error", reason: "error", errorMessage: "connection reset" });
		expect(parsed[2]).toBe("[DONE]");
	});
});

describe("auth-gateway model listing", () => {
	it("returns qualified ids and OMP metadata for listed models", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-gateway-models-list-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		const handle = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [],
			resolveModel: () => undefined,
			listModels: () => [
				buildModel({
					id: "same-id",
					name: "Acme Same",
					provider: "acme",
					api: "openai-completions",
					baseUrl: "https://acme.example/v1",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
					contextWindow: 123456,
					maxTokens: 7890,
					supportsTools: true,
				}),
				buildModel({
					id: "same-id",
					name: "Beta Same",
					provider: "beta",
					api: "openai-completions",
					baseUrl: "https://beta.example/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 64000,
					maxTokens: 2048,
				}),
			],
		});
		try {
			const res = await fetch(`${handle.url}/v1/models`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: Array<Record<string, unknown>> };
			expect(body.data.map(item => item.id)).toEqual(["acme/same-id", "beta/same-id"]);
			expect(body.data[0]).toMatchObject({
				id: "acme/same-id",
				owned_by: "acme",
				api: "openai-completions",
				name: "Acme Same",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 123456,
				maxTokens: 7890,
				supportsTools: true,
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			});
		} finally {
			await handle.close();
			storage.close();
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("pi-native keyless gateway dispatch", () => {
	it("allows auth:none catalog models without broker credentials", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-gateway-keyless-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		const final = baseAssistant({ api: "keyless-test-api", provider: "keyless", model: "free-chat" });
		const seenKeys: unknown[] = [];
		registerCustomApi("keyless-test-api", (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			seenKeys.push(options?.apiKey);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.end(final));
			return stream;
		});
		const handle = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [],
			resolveModel: () => ({
				...buildModel({
					id: "free-chat",
					name: "Free Chat",
					provider: "keyless",
					api: "keyless-test-api",
					baseUrl: "https://keyless.example/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				}),
				auth: "none" as const,
			}),
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: "keyless/free-chat", context: baseContext, stream: false }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ message: JSON.parse(JSON.stringify(final)) });
			expect(seenKeys).toEqual([undefined]);
		} finally {
			await handle.close();
			storage.close();
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("routes pi-native qualified remote ids without local gateway provider prefix", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-gateway-qualified-pi-native-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.setRuntimeApiKey("acme", "test-key");
		await storage.reload();
		let requestedModelId: string | undefined;
		const final = baseAssistant({ api: "qualified-test-api", provider: "acme", model: "same-id" });
		registerCustomApi("qualified-test-api", (model: Model<Api>) => {
			requestedModelId = model.id;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.end(final));
			return stream;
		});
		const handle = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [],
			resolveModel: id => {
				if (id !== "acme/same-id") return undefined;
				return buildModel({
					id: "same-id",
					name: "Acme Same",
					provider: "acme",
					api: "qualified-test-api",
					baseUrl: "https://acme.example/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				});
			},
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: "acme/same-id", context: baseContext, stream: false }),
			});
			expect(res.status).toBe(200);
			expect((await res.json()) as { message: unknown }).toEqual({ message: JSON.parse(JSON.stringify(final)) });
			expect(requestedModelId).toBe("same-id");
		} finally {
			await handle.close();
			storage.close();
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps local provider prefix for slashy non-gateway model ids", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-gateway-slashy-pi-native-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		let requestedModelId: string | undefined;
		await storage.setRuntimeApiKey("openrouter", "test-key");
		const final = baseAssistant({ api: "slashy-test-api", provider: "openrouter", model: "anthropic/claude-sonnet" });
		registerCustomApi("slashy-test-api", (model: Model<Api>) => {
			requestedModelId = `${model.provider}/${model.id}`;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.end(final));
			return stream;
		});
		const handle = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [],
			resolveModel: id => {
				if (id !== "openrouter/anthropic/claude-sonnet") return undefined;
				return buildModel({
					id: "anthropic/claude-sonnet",
					name: "OpenRouter Claude",
					provider: "openrouter",
					api: "slashy-test-api",
					baseUrl: "https://openrouter.example/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				});
			},
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "openrouter/anthropic/claude-sonnet",
					context: baseContext,
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			expect(requestedModelId).toBe("openrouter/anthropic/claude-sonnet");
		} finally {
			await handle.close();
			storage.close();
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("allows auth:none OpenAI-compatible models without broker credentials", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-gateway-keyless-openai-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		await storage.setRuntimeApiKey("keyless-openai", "must-not-leak");
		let receivedAuthorization: string | null = null;
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				receivedAuthorization = request.headers.get("authorization");
				return new Response(
					[
						'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"content":"ok"}}]}',
						'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
						"data: [DONE]",
						"",
					].join("\n\n"),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const handle = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [],
			resolveModel: () => ({
				...buildModel({
					id: "free-chat",
					name: "Free Chat",
					provider: "keyless-openai",
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				}),
				auth: "none" as const,
			}),
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: "keyless-openai/free-chat", context: baseContext, stream: false }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { message: { content: unknown } };
			expect(body.message.content).toEqual([{ type: "text", text: "ok" }]);
			expect(receivedAuthorization).toBeNull();
		} finally {
			await handle.close();
			upstream.stop(true);
			storage.close();
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("pi-native formatError", () => {
	it("emits { error: { type, message } } with the given status", async () => {
		const res = formatError(401, "authentication_error", "no credential");
		expect(res.status).toBe(401);
		expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(await res.json()).toEqual({ error: { type: "authentication_error", message: "no credential" } });
	});
});
