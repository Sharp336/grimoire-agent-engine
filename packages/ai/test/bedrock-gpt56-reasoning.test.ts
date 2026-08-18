import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { type BedrockOptions, streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import type { AssistantMessageEvent, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;

beforeAll(() => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
});

afterAll(() => {
	if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
});

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.openai.gpt-5.6-sol",
		name: "GPT-5.6 Sol (US)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.875 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
	});
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

interface CapturedPayload {
	additionalModelRequestFields?: Record<string, unknown>;
	inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
	messages: Array<{ role: string; content: unknown[] }>;
}

const baseContext: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

function capturePayload(options: Partial<BedrockOptions>, context: Context = baseContext): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	void streamBedrock(model(), context, {
		...options,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as CapturedPayload),
	});
	return promise;
}

// --- Bedrock ConverseStream eventstream frame encoder, mirrors issue-3124-repro.test.ts ---

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buffer = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buffer.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	buffer.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	buffer.set(valueBytes, offset);
	return buffer;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let offset = 0;
	for (const chunk of headerChunks) {
		headerBytes.set(chunk, offset);
		offset += chunk.length;
	}
	const totalLength = 4 + 4 + 4 + headerLength + payload.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function encodeBedrockEvent(eventType: string, payload: string): Uint8Array {
	return encodeFrame({ ":message-type": "event", ":event-type": eventType }, new TextEncoder().encode(payload));
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	});
}

function redactedReasoningFetch(): FetchImpl {
	const frames = [
		encodeBedrockEvent("messageStart", '{"role":"assistant"}'),
		encodeBedrockEvent(
			"contentBlockDelta",
			'{"contentBlockIndex":0,"delta":{"reasoningContent":{"redactedContent":"AAA"}}}',
		),
		encodeBedrockEvent(
			"contentBlockDelta",
			'{"contentBlockIndex":0,"delta":{"reasoningContent":{"redactedContent":"BBB"}}}',
		),
		encodeBedrockEvent("contentBlockStop", '{"contentBlockIndex":0}'),
		encodeBedrockEvent("contentBlockDelta", '{"contentBlockIndex":1,"delta":{"text":"hi"}}'),
		encodeBedrockEvent("contentBlockStop", '{"contentBlockIndex":1}'),
		encodeBedrockEvent("messageStop", '{"stopReason":"end_turn"}'),
		encodeBedrockEvent("metadata", '{"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}'),
	];
	return Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit) =>
			new Response(streamFrom(frames), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
		{ preconnect: fetch.preconnect },
	);
}

describe("GPT-5.6 reasoning on Bedrock Converse", () => {
	test("sends reasoning.effort on the wire and drops temperature/topP", async () => {
		const payload = await capturePayload({ reasoning: Effort.High, temperature: 0.7, topP: 0.9 });
		expect(payload.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
		expect(Object.keys(payload.inferenceConfig ?? {})).toEqual(["maxTokens"]);
	});

	test("distinguishes explicit effort, explicit off, and no preference", async () => {
		const explicit = await capturePayload({ reasoning: Effort.High });
		expect(explicit.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });

		const off = await capturePayload({ disableReasoning: true });
		expect(off.additionalModelRequestFields).toEqual({ reasoning: { effort: "none" } });

		const noPreference = await capturePayload({});
		expect(noPreference.additionalModelRequestFields).toBeUndefined();
	});

	test("keeps GPT-5.6 reasoning.effort under a forced tool choice", async () => {
		const tool: Tool = {
			name: "get_weather",
			description: "Get the weather for a city",
			parameters: type({ city: type("string") }),
		};
		const payload = await capturePayload(
			{ reasoning: Effort.High, toolChoice: "any" },
			{ ...baseContext, tools: [tool] },
		);
		expect(payload.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
	});

	test("streams redacted reasoning as an opaque carrier with no visible thinking event, then replays it on the next turn", async () => {
		const stream = streamBedrock(model(), baseContext, { reasoning: Effort.High, fetch: redactedReasoningFetch() });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.some(event => event.type === "thinking_start" || event.type === "thinking_end")).toBe(false);

		const redactedBlocks = result.content.filter(block => block.type === "redactedThinking");
		expect(redactedBlocks).toHaveLength(1);
		expect(redactedBlocks[0]).toMatchObject({ type: "redactedThinking", data: "AAABBB" });
		expect(result.content.some(block => block.type === "thinking")).toBe(false);

		const payload = await capturePayload({ reasoning: Effort.High }, { messages: [...baseContext.messages, result] });
		const assistantWireMessage = payload.messages.find(m => m.role === "assistant");
		expect(assistantWireMessage?.content).toContainEqual({ reasoningContent: { redactedContent: "AAABBB" } });
	});
});
