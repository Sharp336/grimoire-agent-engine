import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
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

	it("records native HTTP/2 requests when request debugging is enabled", async () => {
		const payload = connectFrame(
			toBinary(
				GetChatMessageResponseSchema,
				create(GetChatMessageResponseSchema, { deltaText: "debugged", stopReason: StopReason.STOP_PATTERN }),
			),
		);
		const server = http2.createServer();
		server.on("stream", (request: http2.ServerHttp2Stream) => {
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
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-h2-debug-"));
		try {
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { stream } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
process.chdir(Bun.env.TEST_TEMP_DIR);
const model = buildModel({ id: "debug", name: "debug", api: "devin-agent", provider: "devin", baseUrl: Bun.env.TEST_BASE_URL, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 });
const result = await stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: "token" }).result();
process.stdout.write(result.stopReason);`,
				],
				{
					cwd: new URL("..", import.meta.url).pathname,
					env: {
						...process.env,
						PI_REQ_DEBUG: "1",
						TEST_TEMP_DIR: tempDir,
						TEST_BASE_URL: `http://127.0.0.1:${address.port}`,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toBe("stop");
			const files = await fs.readdir(tempDir);
			expect(files.some(file => /^rr-session-\d+\.json$/.test(file))).toBeTrue();
			expect(files.some(file => /^rr-session-\d+\.res\.log$/.test(file))).toBeTrue();
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			await fs.rm(tempDir, { recursive: true, force: true });
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
	it("settles transport disposal even when response debug-log cleanup rejects", async () => {
		// With PI_REQ_DEBUG=1 the provider opens a response log at `rr-session-N.res.log`
		// relative to cwd via fs.open(path, "wx"). Pre-creating that exact path as a
		// DIRECTORY makes the open reject deterministically, which is the real-world
		// unwritable-cwd / full-disk case. If that rejection escapes the teardown,
		// disposeTransports() awaits a settlement promise nothing can resolve and the
		// child never exits.
		const debugDir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-debuglog-"));
		await fs.mkdir(path.join(debugDir, "rr-session-1.res.log"));
		const pkgRoot = new URL("..", import.meta.url).pathname;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { streamDevin } from "${pkgRoot}src/providers/devin.ts";
import { disposeTransports } from "${pkgRoot}src/transport/lifecycle.ts";
const terminal = new Uint8Array([2, 0, 0, 0, 0]);
const model = {
	id: "devin-debuglog-test",
	name: "Devin debug-log test",
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
	fetch: async () => new Response(terminal, { status: 200 }),
}).result();
await disposeTransports();
process.stdout.write(JSON.stringify({ stopReason: result.stopReason }));`,
			],
			{ cwd: debugDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_REQ_DEBUG: "1" } },
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			// A hard deadline is the assertion here, not a tuned sleep: the defect under
			// test is "disposal waits forever", so without it the suite would hang
			// instead of failing. There is no fake-timer path when racing a real
			// subprocess exit.
			const deadline = Promise.withResolvers<never>();
			const timeout = setTimeout(() => deadline.reject(new Error("Devin debug-log child did not exit")), 5_000);
			let exitCode: number;
			try {
				exitCode = await Promise.race([child.exited, deadline.promise]);
			} finally {
				clearTimeout(timeout);
			}
			const [output, errors] = await Promise.all([stdout, stderr]);
			expect(exitCode, errors).toBe(0);
			expect(JSON.parse(output)).toEqual({ stopReason: "stop" });
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await fs.rm(debugDir, { recursive: true, force: true });
		}
	});
});
