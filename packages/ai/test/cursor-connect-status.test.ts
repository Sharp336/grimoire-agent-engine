import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { __evictH2PoolEntry } from "@oh-my-pi/pi-ai/providers/cursor/h2-pool";
import { __evictServerConfigEntry } from "@oh-my-pi/pi-ai/providers/cursor/server-config";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const CONNECT_END_STREAM_FLAG = 0b00000010;

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectEndErrorFrame(code: string, message: string): Buffer {
	const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
	return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

let server: http2.Http2Server | undefined;
let activeBaseUrl: string | undefined;
const sessions = new Set<http2.Http2Session>();
const attemptHeaders: http2.IncomingHttpHeaders[] = [];
let handleAttempt: (attemptIndex: number, stream: http2.ServerHttp2Stream) => void = (_i, stream) => {
	stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
	stream.write(Buffer.concat([textDeltaFrame("hi"), turnEndedFrame()]));
	stream.end();
};

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("error", () => {});
		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		const attemptIndex = attemptHeaders.length;
		attemptHeaders.push(headers);
		handleAttempt(attemptIndex, stream);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	activeBaseUrl = `http://127.0.0.1:${address.port}`;
	return activeBaseUrl;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-retry-fixture",
		name: "Cursor retry fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "retry lifecycle", timestamp: 1 }],
};

interface CollectResult {
	eventTypes: string[];
	stopReason: string;
	retryDelays: number[];
}

async function collect(model: Model<"cursor-agent">, options?: { signal?: AbortSignal }): Promise<CollectResult> {
	const retryDelays: number[] = [];
	const stream = streamCursor(model, context, {
		apiKey: "test-token",
		signal: options?.signal,
		// Deterministic, instant backoff that still records the capped jitter delay.
		providerRetryWait: async (delayMs: number) => {
			retryDelays.push(delayMs);
		},
	});
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
	}
	const result = await stream.result();
	return { eventTypes, stopReason: result.stopReason, retryDelays };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

afterEach(async () => {
	attemptHeaders.length = 0;
	handleAttempt = (_i, stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(Buffer.concat([textDeltaFrame("hi"), turnEndedFrame()]));
		stream.end();
	};
	if (activeBaseUrl) {
		__evictH2PoolEntry(activeBaseUrl);
		__evictServerConfigEntry(activeBaseUrl, "test-token");
		activeBaseUrl = undefined;
	}
	await stopServer();
});

describe("Cursor Connect terminal behavior without the CLI retry feature signal", () => {
	it("does not automatically replay a transient failure", async () => {
		const baseUrl = await startServer();
		handleAttempt = (_attemptIndex, stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(connectEndErrorFrame("unavailable", "try again"));
			stream.end();
		};

		const { stopReason, retryDelays } = await collect(makeModel(baseUrl));

		expect(stopReason).toBe("error");
		expect(attemptHeaders).toHaveLength(1);
		expect(attemptHeaders[0]?.["x-request-id"]).toBeTruthy();
		expect(attemptHeaders[0]?.["x-original-request-id"]).toBeTruthy();
		expect(retryDelays).toEqual([]);
	});

	it("does not invoke retry waiting for a transient failure", async () => {
		const baseUrl = await startServer();
		handleAttempt = (_attemptIndex, stream) => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(connectEndErrorFrame("unavailable", "try again"));
			stream.end();
		};
		let waited = false;
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			providerRetryWait: async () => {
				waited = true;
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(waited).toBe(false);
		expect(attemptHeaders).toHaveLength(1);
	});
});
