// `after_provider_response` (docs/extensions.md:293) is documented as firing
// "after a provider response is received, before its stream body is consumed",
// with no provider exclusions. Regression: amazon-bedrock, ollama, and
// google-gemini-cli each held a real `Response` and never called
// `notifyProviderResponse`, so every response from those providers was invisible
// to extensions — including the 401/402/429 that credential and rate-limit
// handlers exist to see.
//
// Two contracts are defended per provider:
//  1. a 2xx response fires exactly one event carrying status + lowercased
//     headers, and the provider still produces its normal result afterwards
//     (i.e. the notification did not consume the body);
//  2. a non-2xx response STILL fires the event, before the provider surfaces the
//     failure. A "fire only after `response.ok`" fix passes (1) and fails (2).
import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import type { Api, AssistantMessage, Context, FetchImpl, Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

interface Recorder {
	calls: ProviderResponseMetadata[];
	/** Model ids seen alongside each event, proving the model is threaded through. */
	models: (string | undefined)[];
	onResponse: (response: ProviderResponseMetadata, model?: Model<Api>) => void;
}

/**
 * Ordering relative to body consumption is deliberately NOT asserted by inspecting a
 * stream-pull flag: `new Response(stream)` may begin pulling as soon as it is
 * constructed, before any provider code runs, so such a flag can never be observed
 * false on a 2xx fixture and is vacuous on an error fixture with a string body.
 *
 * The contract is instead pinned by two assertions that cannot pass accidentally:
 * the event fires on a non-2xx status *before* the provider throws, and the 2xx run
 * still produces its full assistant message (so notification did not consume the body).
 */
function recorder(): Recorder {
	const rec: Recorder = {
		calls: [],
		models: [],
		onResponse: () => {},
	};
	rec.onResponse = (response, model) => {
		rec.calls.push(response);
		rec.models.push(model?.id);
	};
	return rec;
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(chunks[index]!);
			index += 1;
		},
	});
}

function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

// A 429 is a retryable status, so `fetchWithRetry` would replay it (and fire one
// event per attempt). A `retry-after` beyond the caller's delay cap makes it
// return the first response immediately, keeping the "exactly once" assertion
// about ordering rather than about retry counts.
const RATE_LIMIT_HEADERS = { "retry-after": "3600", "X-Amzn-RequestId": "req-429" };

// ---------------------------------------------------------------------------
// amazon-bedrock — AWS eventstream framing
// ---------------------------------------------------------------------------

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = utf8(name);
	const valueBytes = utf8(value);
	const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(header.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	header.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	header.set(valueBytes, offset);
	return header;
}

function encodeEventFrame(eventType: string, payload: unknown): Uint8Array {
	const headerChunks = [encodeStringHeader(":message-type", "event"), encodeStringHeader(":event-type", eventType)];
	const headerLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const headers = new Uint8Array(headerLength);
	let headerOffset = 0;
	for (const chunk of headerChunks) {
		headers.set(chunk, headerOffset);
		headerOffset += chunk.length;
	}
	const body = utf8(JSON.stringify(payload));
	const totalLength = 4 + 4 + 4 + headerLength + body.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headers, 12);
	frame.set(body, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

const BEDROCK_OK_FRAMES: readonly Uint8Array[] = [
	encodeEventFrame("messageStart", { role: "assistant" }),
	encodeEventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "bedrock ok" } }),
	encodeEventFrame("contentBlockStop", { contentBlockIndex: 0 }),
	encodeEventFrame("messageStop", { stopReason: "end_turn" }),
	encodeEventFrame("metadata", { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }),
];

function bedrockModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		name: "haiku",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function runBedrock(response: () => Response, rec: Recorder): Promise<AssistantMessage> {
	const fetchMock: FetchImpl = async () => response();
	return streamBedrock(bedrockModel(), context, {
		bearerToken: "test-token",
		fetch: fetchMock,
		onResponse: rec.onResponse,
	}).result();
}

describe("amazon-bedrock after_provider_response", () => {
	it("fires exactly once on a 2xx response and still streams the body", async () => {
		const rec = recorder();
		const result = await runBedrock(
			() =>
				new Response(streamOf(BEDROCK_OK_FRAMES), {
					status: 200,
					headers: {
						"content-type": "application/vnd.amazon.eventstream",
						// Mixed case on the wire: extensions index the payload by
						// lower-cased name, so the event must normalize it.
						"X-Amzn-RequestId": "req-bedrock-ok",
					},
				}),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(200);
		expect(rec.calls[0]?.headers["x-amzn-requestid"]).toBe("req-bedrock-ok");
		expect(Object.keys(rec.calls[0]?.headers ?? {})).not.toContain("X-Amzn-RequestId");
		expect(rec.calls[0]?.requestId).toBe("req-bedrock-ok");
		expect(rec.models[0]).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
		// The body was still fully consumable after the event fired.
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "bedrock ok" }]);
		expect(result.usage?.input).toBe(12);
	});

	// Load-bearing case: a "fire after !response.ok" fix would never reach here,
	// hiding rate limits from the handlers that back off on them.
	it("fires on a 429 before surfacing the rate-limit failure", async () => {
		const rec = recorder();
		const result = await runBedrock(
			() => new Response('{"message":"Too many requests"}', { status: 429, headers: RATE_LIMIT_HEADERS }),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(429);
		expect(rec.calls[0]?.headers["retry-after"]).toBe("3600");
		expect(rec.calls[0]?.requestId).toBe("req-429");
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	// Same rule for auth: a credential handler must see the 401.
	it("fires on a 401 before surfacing the auth failure", async () => {
		const rec = recorder();
		const result = await runBedrock(
			() => new Response('{"message":"The security token is invalid"}', { status: 401 }),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(401);
		// The error path reads `response.text()` only after the event fired.
		expect(rec.calls[0]?.requestId).toBeNull();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// ollama — newline-delimited JSON
// ---------------------------------------------------------------------------

const OLLAMA_OK_CHUNKS: readonly Uint8Array[] = [
	utf8('{"message":{"content":"ollama ok"},"done":true,"done_reason":"stop","prompt_eval_count":7,"eval_count":3}\n'),
];

function ollamaModel(): Model<"ollama-chat"> {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function runOllama(response: () => Response, rec: Recorder): Promise<AssistantMessage> {
	const fetchMock: FetchImpl = async () => response();
	return streamOllama(ollamaModel(), context, {
		apiKey: "test-key",
		fetch: fetchMock,
		onResponse: rec.onResponse,
	}).result();
}

describe("ollama after_provider_response", () => {
	it("fires exactly once on a 2xx response and still streams the body", async () => {
		const rec = recorder();
		const result = await runOllama(
			() =>
				new Response(streamOf(OLLAMA_OK_CHUNKS), {
					status: 200,
					headers: { "Content-Type": "application/x-ndjson" },
				}),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(200);
		expect(rec.calls[0]?.headers["content-type"]).toBe("application/x-ndjson");
		expect(Object.keys(rec.calls[0]?.headers ?? {})).not.toContain("Content-Type");
		// Ollama exposes no request-id header, so the argument is omitted entirely
		// rather than filled with a guessed header name.
		expect(rec.calls[0]?.requestId).toBeUndefined();
		expect(rec.models[0]).toBe("deepseek-v4-flash");
		expect(result.content).toMatchObject([{ type: "text", text: "ollama ok" }]);
		expect(result.stopReason).toBe("stop");
	});

	// A "fire after the `!response.ok` branch" fix would never fire here.
	it("fires on a 429 before surfacing the rate-limit failure", async () => {
		const rec = recorder();
		const result = await runOllama(
			() => new Response('{"error":"busy"}', { status: 429, headers: { "retry-after": "3600" } }),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(429);
		expect(rec.calls[0]?.headers["retry-after"]).toBe("3600");
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	it("fires on a 401 before surfacing the auth failure", async () => {
		const rec = recorder();
		const result = await runOllama(() => new Response('{"error":"unauthorized"}', { status: 401 }), rec);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(401);
		// `captureHttpErrorResponse` reads the body only after the event fired.
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// google-gemini-cli — SSE
// ---------------------------------------------------------------------------

const GEMINI_OK_CHUNKS: readonly Uint8Array[] = [
	utf8(
		`data: ${JSON.stringify({
			response: { candidates: [{ content: { parts: [{ text: "gemini ok" }] }, finishReason: "STOP" }] },
		})}\n\n`,
	),
];

function geminiModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro",
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function runGemini(response: () => Response, rec: Recorder): Promise<AssistantMessage> {
	const fetchMock: FetchImpl = async () => response();
	return streamGoogleGeminiCli(geminiModel(), context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		fetch: fetchMock,
		// Caps the retry delay so a `retry-after` hint returns the 429 response
		// on the first attempt instead of replaying it.
		maxRetryDelayMs: 1,
		onResponse: rec.onResponse,
	}).result();
}

describe("google-gemini-cli after_provider_response", () => {
	it("fires exactly once on a 2xx response and still streams the body", async () => {
		const rec = recorder();
		const result = await runGemini(
			() =>
				new Response(streamOf(GEMINI_OK_CHUNKS), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(200);
		expect(rec.calls[0]?.headers["content-type"]).toBe("text/event-stream");
		expect(Object.keys(rec.calls[0]?.headers ?? {})).not.toContain("Content-Type");
		// Cloud Code Assist exposes no request-id header.
		expect(rec.calls[0]?.requestId).toBeUndefined();
		expect(rec.models[0]).toBe("gemini-3.1-pro-preview");
		expect(result.content).toMatchObject([{ type: "text", text: "gemini ok" }]);
		expect(result.stopReason).toBe("stop");
	});

	// Gemini's `!response.ok` branch can `continue` to the next endpoint without
	// throwing at all, so gating the event on 2xx would hide both the rate limit
	// and the silent failover.
	it("fires on a 429 before surfacing the rate-limit failure", async () => {
		const rec = recorder();
		const result = await runGemini(
			() =>
				new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { "retry-after": "3600" } }),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(429);
		expect(rec.calls[0]?.headers["retry-after"]).toBe("3600");
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	it("fires on a 401 before surfacing the auth failure", async () => {
		const rec = recorder();
		const result = await runGemini(
			() => new Response('{"error":{"message":"invalid credentials"}}', { status: 401 }),
			rec,
		);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(401);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
	});
});
