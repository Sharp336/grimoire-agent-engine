// `after_provider_response` fires for a provider response that is about to be
// streamed. Regression it defends: amazon-bedrock, ollama, and
// google-gemini-cli each held a real `Response` and never called
// `notifyProviderResponse` at all, so successful responses from those providers
// were invisible to extensions.
//
// The firing point is deliberately *after* the `!response.ok` branch and after
// any body guard, which is where `anthropic.ts` and the two OpenAI providers
// already sit: they notify only once `getAnthropicStreamResponse` /
// `postOpenAIStream` has returned, and those helpers throw on any non-2xx. So no
// provider in the tree has ever surfaced a 401/403/429/5xx through this event.
//
// THE EXPECTATION BELOW CHANGED DELIBERATELY. An earlier revision of this file
// asserted the opposite — that these three providers fire on error statuses too,
// placing the call before the `.ok` gate so credential and rate-limit handlers
// could observe them. That is a strictly broader and arguably better contract,
// but adopting it in three providers while anthropic/openai-completions/
// openai-responses stay success-only means an extension sees 429 from Bedrock and
// nothing from Anthropic. Uniform pre-gate firing across every provider is the
// rejected alternative: worth doing, but as its own change with every provider
// migrated together, not as a divergence introduced here.
//
// Three contracts are defended per provider:
//  1. a 2xx response fires exactly one event carrying status, lowercased
//     headers, the threaded model and the request id, and the provider still
//     produces its full assistant message (so notification did not consume the
//     body);
//  2. a non-2xx response fires NO event, and the failure is still surfaced. A
//     regression that moves the call back above the `.ok` gate fails this;
//  3. (google-gemini-cli) exactly one event per logical request even when the
//     endpoint-failover loop burns an endpoint. A notify above the gate fires
//     once per attempted endpoint, because a transient status there `continue`s
//     to the next endpoint without throwing.
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
 * What pins the contract instead: the 2xx run still produces its full assistant
 * message (so the notification did not consume the body), and the error runs still
 * surface their status while firing nothing.
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

// A 429 is a retryable status, so `fetchWithRetry` would replay it. A `retry-after`
// beyond the caller's delay cap makes it return the first response immediately, so
// the "no event fired" assertion is about the gate and not about how many attempts
// happened to be made.
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

	// Load-bearing case: a regression that moves the notify above the `!response.ok`
	// branch fires here, diverging from anthropic/openai. The failure must still be
	// surfaced with its status, so the assertion cannot pass by the provider
	// swallowing the response.
	it("fires no event on a 429 and still surfaces the rate-limit failure", async () => {
		const rec = recorder();
		const result = await runBedrock(
			() => new Response('{"message":"Too many requests"}', { status: 429, headers: RATE_LIMIT_HEADERS }),
			rec,
		);

		expect(rec.calls).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	// Same rule for auth: the credential-invalidation path runs without an event.
	it("fires no event on a 401 and still surfaces the auth failure", async () => {
		const rec = recorder();
		const result = await runBedrock(
			() => new Response('{"message":"The security token is invalid"}', { status: 401 }),
			rec,
		);

		expect(rec.calls).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
	});

	// The body guard sits between the `.ok` check and the notify, so a 200 with no
	// body must not fire either — otherwise an extension would be told a stream is
	// coming that the provider immediately rejects.
	it("fires no event on a 200 with no body", async () => {
		const rec = recorder();
		const result = await runBedrock(() => new Response(null, { status: 204 }), rec);

		expect(rec.calls).toHaveLength(0);
		expect(result.stopReason).toBe("error");
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

	it("fires no event on a 429 and still surfaces the rate-limit failure", async () => {
		const rec = recorder();
		const result = await runOllama(
			() => new Response('{"error":"busy"}', { status: 429, headers: { "retry-after": "3600" } }),
			rec,
		);

		expect(rec.calls).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	it("fires no event on a 401 and still surfaces the auth failure", async () => {
		const rec = recorder();
		const result = await runOllama(() => new Response('{"error":"unauthorized"}', { status: 401 }), rec);

		expect(rec.calls).toHaveLength(0);
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

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

function runGemini(model: Model<"google-gemini-cli">, fetchMock: FetchImpl, rec: Recorder): Promise<AssistantMessage> {
	return streamGoogleGeminiCli(model, context, {
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
			geminiModel(),
			async () =>
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

	it("fires no event on a 429 and still surfaces the rate-limit failure", async () => {
		const rec = recorder();
		const result = await runGemini(
			geminiModel(),
			async () =>
				new Response('{"error":{"message":"rate limited"}}', {
					status: 429,
					headers: { "retry-after": "3600" },
				}),
			rec,
		);

		expect(rec.calls).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	it("fires no event on a 401 and still surfaces the auth failure", async () => {
		const rec = recorder();
		const result = await runGemini(
			geminiModel(),
			async () => new Response('{"error":{"message":"invalid credentials"}}', { status: 401 }),
			rec,
		);

		expect(rec.calls).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
	});

	// The regression a misplaced notify causes here is *duplication*, not silence:
	// a transient status on a non-final endpoint `continue`s the loop without
	// throwing, so a notify above the `.ok` gate fires once per burnt endpoint and
	// an extension counting responses double-counts one logical request.
	it("fires exactly once per logical request when the failover loop burns an endpoint", async () => {
		const rec = recorder();
		const requested: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			requested.push(url);
			if (url.startsWith(ANTIGRAVITY_DAILY_ENDPOINT)) {
				return new Response('{"error":{"message":"unavailable"}}', { status: 503 });
			}
			return new Response(streamOf(GEMINI_OK_CHUNKS), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		// The Antigravity provider is the only google-gemini-cli shape with more than
		// one endpoint (`[daily, sandbox]` in the default "auto" mode), so it is the
		// only way to exercise the failover loop that a misplaced notify multiplies.
		const model = buildModel({
			...geminiModel(),
			provider: "google-antigravity",
			baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
		});
		const result = await runGemini(model, fetchMock, rec);

		// Both endpoints really were attempted — otherwise "exactly once" would be
		// vacuously true because no failover happened.
		expect(requested).toHaveLength(2);
		expect(requested[0]?.startsWith(ANTIGRAVITY_DAILY_ENDPOINT)).toBe(true);
		expect(requested[1]?.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT)).toBe(true);

		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.status).toBe(200);
		expect(result.content).toMatchObject([{ type: "text", text: "gemini ok" }]);
		expect(result.stopReason).toBe("stop");
	});
});
