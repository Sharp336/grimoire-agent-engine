import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const CONNECT_END_STREAM_FLAG = 0b00000010;

// Per-stream behavior keyed by the 1-based attempt index the server has seen.
type PerAttempt = (attempt: number) => "transient-before-message" | "transient-after-message" | "success";

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let attemptCount = 0;
let behavior: PerAttempt = () => "success";

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

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
		stream.on("data", () => {});
		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		attemptCount += 1;
		const kind = behavior(attemptCount);
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		if (kind === "transient-before-message") {
			stream.write(connectEndErrorFrame("unavailable", "Connect error unavailable: Error"));
			stream.end();
			return;
		}
		if (kind === "transient-after-message") {
			stream.write(textDeltaFrame("hi"));
			stream.write(connectEndErrorFrame("unavailable", "Connect error unavailable: Error"));
			stream.end();
			return;
		}
		stream.write(Buffer.concat([textDeltaFrame("hello"), turnEndedFrame()]));
		stream.end();
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	return `http://127.0.0.1:${address.port}`;
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
	messages: [{ role: "user", content: "retry contract", timestamp: 1 }],
};

async function collectStream(model: Model<"cursor-agent">) {
	const stream = streamCursor(model, context, { apiKey: "test-token" });
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
	}
	return { eventTypes, result: await stream.result() };
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
	attemptCount = 0;
	behavior = () => "success";
	await stopServer();
});

describe("Cursor replay-safe transient retry", () => {
	it("replays a transient failure that arrives before any server message and then succeeds", async () => {
		behavior = attempt => (attempt === 1 ? "transient-before-message" : "success");
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(attemptCount).toBe(2);
		expect(eventTypes).toContain("done");
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("does not replay once a server message has been seen", async () => {
		behavior = () => "transient-after-message";
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(attemptCount).toBe(1);
		expect(eventTypes).not.toContain("done");
		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connect error unavailable");
	});

	it("stops after three total attempts when every attempt fails transiently", async () => {
		behavior = () => "transient-before-message";
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(attemptCount).toBe(3);
		expect(eventTypes).not.toContain("done");
		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connect error unavailable");
	});
});
