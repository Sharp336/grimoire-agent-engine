import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { disposeH2Pool, encodeConnectFrame } from "@oh-my-pi/pi-ai/transport";
import type { AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { disposeServerConfigCache } from "../src/providers/cursor/server-config";

const CONNECT_END_STREAM_FLAG = 0x02;
const context: Context = { messages: [{ role: "user", content: "grammar", timestamp: 1 }] };
const servers = new Set<http2.Http2Server>();

function model(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-grammar-test",
		name: "Cursor grammar test",
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

async function serve(wire: Uint8Array): Promise<string> {
	const server = http2.createServer();
	servers.add(server);
	server.on("stream", stream => {
		stream.on("data", () => {});
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.end(wire);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected Cursor grammar fixture port");
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	await disposeServerConfigCache();
	await disposeH2Pool();
	await Promise.all(
		Array.from(servers, server => {
			const closed = Promise.withResolvers<void>();
			server.close(closed.resolve);
			return closed.promise;
		}),
	);
	servers.clear();
});

describe("Cursor public Connect grammar", () => {
	it.each([
		["malformed terminal payload", encodeConnectFrame(new TextEncoder().encode("{"), CONNECT_END_STREAM_FLAG)],
		[
			"duplicate end-of-stream",
			Buffer.concat([
				encodeConnectFrame(new Uint8Array(), CONNECT_END_STREAM_FLAG),
				encodeConnectFrame(new Uint8Array(), CONNECT_END_STREAM_FLAG),
			]),
		],
		[
			"data after end-of-stream",
			Buffer.concat([
				encodeConnectFrame(new Uint8Array(), CONNECT_END_STREAM_FLAG),
				encodeConnectFrame(new Uint8Array([1])),
			]),
		],
		["EOF without end-of-stream", new Uint8Array()],
	] as const)("rejects %s before terminal success events", async (_name, wire) => {
		const baseUrl = await serve(wire);
		const events: AssistantMessageEvent[] = [];
		for await (const event of streamCursor(model(baseUrl), context, {
			apiKey: "grammar-token",
			conversationId: crypto.randomUUID(),
		})) {
			events.push(event);
		}
		expect(events.some(event => event.type === "error")).toBeTrue();
		expect(events.some(event => event.type === "done")).toBeFalse();
		expect(
			events.some(
				event => event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end",
			),
		).toBeFalse();
	});
});
