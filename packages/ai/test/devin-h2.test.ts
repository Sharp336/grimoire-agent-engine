import { describe, expect, it } from "bun:test";
import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetChatMessageResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { StopReason } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

function connectFrame(payload: Uint8Array): Uint8Array {
	const frame = Buffer.alloc(5 + payload.byteLength);
	frame.writeUInt32BE(payload.byteLength, 1);
	frame.set(payload, 5);
	return frame;
}

function testModel(baseUrl: string): Model<"devin-agent"> {
	return buildModel({
		id: "devin-test",
		name: "Devin Test",
		api: "devin-agent",
		provider: "devin",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

describe("Devin HTTP/2 transport", () => {
	it("uses HTTP/2 through public stream() without a fetch override", async () => {
		const payload = connectFrame(
			toBinary(
				GetChatMessageResponseSchema,
				create(GetChatMessageResponseSchema, { deltaText: "hello", stopReason: StopReason.STOP_PATTERN }),
			),
		);
		const server = http2.createServer();
		const headersReady = Promise.withResolvers<http2.IncomingHttpHeaders>();
		server.on("stream", (request: http2.ServerHttp2Stream, headers) => {
			headersReady.resolve(headers);
			request.on("data", () => {});
			request.on("end", () => {
				request.respond({ ":status": 200, "content-type": "application/connect+proto" });
				request.end(payload);
			});
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected HTTP/2 test server address");

		try {
			const result = await stream(
				testModel(`http://127.0.0.1:${address.port}`),
				{
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
				} satisfies Context,
				{ apiKey: "session-token" },
			).result();
			const headers = await headersReady.promise;
			expect(headers).toMatchObject({
				":method": "POST",
				":path": "/exa.api_server_pb.ApiServerService/GetChatMessage",
				"connect-protocol-version": "1",
			});
			expect(headers["user-agent"]).toBeUndefined();
			expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("removes the abort listener when the HTTP/2 response is unsuccessful", async () => {
		const server = http2.createServer();
		server.on("stream", (request: http2.ServerHttp2Stream) => {
			request.on("data", () => {});
			request.on("end", () => {
				request.respond({ ":status": 401, "content-type": "text/plain" });
				request.end("unauthorized");
			});
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected HTTP/2 test server address");

		const controller = new AbortController();
		const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
		let abortListenerRemovals = 0;
		controller.signal.removeEventListener = (type, callback, options) => {
			if (type === "abort") abortListenerRemovals++;
			removeEventListener(type, callback, options);
		};

		try {
			const result = await streamDevin(
				testModel(`http://127.0.0.1:${address.port}`),
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] } satisfies Context,
				{ apiKey: "session-token", signal: controller.signal },
			).result();
			expect(result.stopReason).toBe("error");
			expect(abortListenerRemovals).toBe(1);
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});
});
