import { describe, expect, it } from "bun:test";
import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetChatMessageResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { StopReason } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

function connectFrame(payload: Uint8Array, flags = 0): Uint8Array {
	const frame = Buffer.alloc(5 + payload.byteLength);
	frame[0] = flags;
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
				request.end(Buffer.concat([payload, connectFrame(new Uint8Array(), 0x02)]));
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
			expect(result.stopReason).toBe("stop");
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("uses an explicit fetch override through public stream()", async () => {
		const responseFrames = Buffer.concat([
			connectFrame(
				toBinary(
					GetChatMessageResponseSchema,
					create(GetChatMessageResponseSchema, {
						deltaText: "override",
						stopReason: StopReason.STOP_PATTERN,
					}),
				),
			),
			connectFrame(new Uint8Array(), 0x02),
		]);
		let calls = 0;
		const result = await stream(
			testModel("http://127.0.0.1:1"),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] } satisfies Context,
			{
				apiKey: "session-token",
				fetch: async () => {
					calls++;
					return new Response(responseFrames, {
						status: 200,
						headers: { "content-type": "application/connect+proto" },
					});
				},
			},
		).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "override" }]);
	});
	it("settles transport disposal even when response close rejects", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { streamDevin } from "./src/providers/devin.ts";
import { disposeTransports } from "./src/transport/lifecycle.ts";
const terminal = new Uint8Array([2, 0, 0, 0, 0]);
const response = new Response(terminal, { status: 200 });
let closeCalls = 0;
Object.defineProperty(response.body, "cancel", {
	value: () => {
		closeCalls++;
		return Promise.reject(new Error("close failed"));
	},
});
const model = {
	id: "devin-close-test",
	name: "Devin close test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};
const result = await streamDevin(model, { messages: [] }, {
	apiKey: "token",
	fetch: async () => response,
}).result();
await disposeTransports();
process.stdout.write(JSON.stringify({ stopReason: result.stopReason, closeCalls }));`,
			],
			{ cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			const deadline = Promise.withResolvers<never>();
			const timeout = setTimeout(() => deadline.reject(new Error("Devin disposal child did not exit")), 5_000);
			let exitCode: number;
			try {
				exitCode = await Promise.race([child.exited, deadline.promise]);
			} finally {
				clearTimeout(timeout);
			}
			const [output, errors] = await Promise.all([stdout, stderr]);
			expect(exitCode, errors).toBe(0);
			expect(JSON.parse(output)).toEqual({ stopReason: "stop", closeCalls: 2 });
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	});
});
