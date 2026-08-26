import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import * as http2 from "node:http2";
import { ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import {
	type GetServerConfigResponse,
	GetServerConfigResponseSchema,
	Http2Config,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { encodeConnectFrame } from "../src/providers/cursor/connect-frame";
import * as h2Pool from "../src/providers/cursor/h2-pool";
import { fetchCursorBidiAvailability, resetCursorServerConfigCache } from "../src/providers/cursor/server-config";
import { openCursorTransport } from "../src/providers/cursor/transport";

const RUN_PATH = "/agent.v1.AgentService/Run";
const GET_SERVER_CONFIG_PATH = "/agent.v1.AgentService/GetServerConfig";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const API_KEY = "transport-lifecycle-key";

let h2Server: http2.Http2Server | undefined;
const h2Sessions = new Set<http2.Http2Session>();
let h2Config: Partial<GetServerConfigResponse> = {};

let h1Server: http.Server | undefined;
let h1Hits = 0;
let h1Paths: string[] = [];

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function endFrame(): Buffer {
	return frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG);
}

function alpnCause(): Error {
	return Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
}

async function startH2ConfigServer(): Promise<string> {
	h2Server = http2.createServer();
	h2Server.on("session", session => {
		h2Sessions.add(session);
		session.on("close", () => h2Sessions.delete(session));
	});
	h2Server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("error", () => {});
		if (headers[":path"] !== GET_SERVER_CONFIG_PATH) {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		stream.respond({ ":status": 200, "content-type": "application/proto" });
		const message = create(GetServerConfigResponseSchema, h2Config);
		stream.write(Buffer.concat([frameConnectMessage(toBinary(GetServerConfigResponseSchema, message)), endFrame()]));
		stream.end();
	});
	const listening = Promise.withResolvers<void>();
	h2Server.once("error", listening.reject);
	h2Server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = h2Server.address();
	if (!address || typeof address === "string") throw new Error("expected h2 fixture to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopH2ConfigServer(): Promise<void> {
	for (const session of h2Sessions) session.destroy();
	h2Sessions.clear();
	if (!h2Server) return;
	const closing = h2Server;
	h2Server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

async function startH1Fixture(
	handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
	h1Hits = 0;
	h1Paths = [];
	h1Server = http.createServer((req, res) => {
		h1Hits++;
		h1Paths.push(req.url ?? "");
		if (handler) {
			handler(req, res);
			return;
		}
		res.statusCode = 200;
		res.end();
	});
	const listening = Promise.withResolvers<void>();
	h1Server.once("error", listening.reject);
	h1Server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = h1Server.address();
	if (!address || typeof address === "string") throw new Error("expected h1 fixture to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopH1Fixture(): Promise<void> {
	if (!h1Server) return;
	const closing = h1Server;
	h1Server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

function encodePollResponse(seqno: bigint, data: string, eof: boolean): Uint8Array {
	const parts: Uint8Array[] = [];
	parts.push(encodeVarint(BigInt(1 << 3)), encodeVarint(seqno));
	const dataBytes = Buffer.from(data);
	parts.push(encodeVarint(BigInt((2 << 3) | 2)), encodeVarint(BigInt(dataBytes.length)), dataBytes);
	if (eof) parts.push(encodeVarint(BigInt(3 << 3)), encodeVarint(1n));
	return concatBytes(parts);
}

function encodeVarint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (remaining !== 0n);
	return Uint8Array.from(bytes);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

beforeEach(async () => {
	vi.restoreAllMocks();
	await h2Pool.disposeCursorH2Pool();
	resetCursorServerConfigCache();
	h2Config = {};
	h1Hits = 0;
	h1Paths = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	await h2Pool.disposeCursorH2Pool();
	await stopH2ConfigServer();
	await stopH1Fixture();
	resetCursorServerConfigCache();
});

describe("openCursorTransport lifecycle", () => {
	it("throws on ALPN failure when GetServerConfig is unspecified and opens zero HTTP/1.1 requests", async () => {
		const h1Url = await startH1Fixture();
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: { reason: "alpn", cause: alpnCause() },
		});

		await expect(
			openCursorTransport({
				baseUrl: h1Url,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				gzipRequest: false,
				provider: "cursor",
			}),
		).rejects.toBeInstanceOf(ProviderResponseError);

		expect(h1Hits).toBe(0);
	});

	it("opens the HTTP/1.1 bridge when ALPN fails and GetServerConfig is bidi-disabled", async () => {
		h2Config = { http2Config: Http2Config.FORCE_BIDI_DISABLED };
		const h2Url = await startH2ConfigServer();
		expect(await fetchCursorBidiAvailability({ apiKey: API_KEY, baseUrl: h2Url })).toBe("bidi-disabled");
		await h2Pool.disposeCursorH2Pool();
		await stopH2ConfigServer();

		const payload = Buffer.from("server-frame", "utf8");
		const h1Url = await startH1Fixture((req, res) => {
			if (req.url?.endsWith("RunPoll")) {
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(0n, payload.toString("base64"), false), false),
					encodeConnectFrame(encodePollResponse(1n, "", true), false),
					frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG),
				]);
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.end(body);
				return;
			}
			res.statusCode = 200;
			res.end();
		});

		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: { reason: "alpn", cause: alpnCause() },
		});

		const attempt = await openCursorTransport({
			baseUrl: h1Url,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
			provider: "cursor",
		});

		// The Run path always writes the request body; the bridge poll is gated
		// behind the first append's settlement, so a write is required to start it.
		attempt.write(encodeConnectFrame(Buffer.from("client-request", "utf8"), false));

		const frames: Array<{ kind: string }> = [];
		for await (const frame of attempt.frames()) frames.push(frame);
		expect(frames.some(frame => frame.kind === "data")).toBe(true);
		expect(h1Paths.some(path => path.includes("RunPoll"))).toBe(true);
		attempt.close();
	});

	it("never downgrades a non-ALPN acquisition failure even when config would disable bidi", async () => {
		h2Config = { http2Config: Http2Config.FORCE_BIDI_DISABLED };
		const h2Url = await startH2ConfigServer();
		expect(await fetchCursorBidiAvailability({ apiKey: API_KEY, baseUrl: h2Url })).toBe("bidi-disabled");
		await h2Pool.disposeCursorH2Pool();
		await stopH2ConfigServer();

		const h1Url = await startH1Fixture();
		const tunnelCause = new Error("CONNECT tunnel failed");
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: { reason: "connect-tunnel", cause: tunnelCause },
		});

		await expect(
			openCursorTransport({
				baseUrl: h1Url,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				gzipRequest: false,
				provider: "cursor",
			}),
		).rejects.toBe(tunnelCause);
		expect(h1Hits).toBe(0);
	});

	it("surfaces a post-frame HTTP/2 error without opening HTTP/1.1", async () => {
		await startH1Fixture();

		let server: http2.Http2Server | undefined;
		const sessions = new Set<http2.Http2Session>();
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", () => {});
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(encodeConnectFrame(Buffer.from("first-frame", "utf8"), false));
			// Leave the stream open; the client tears it down after the first frame.
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected live h2 fixture");
		const h2Url = `http://127.0.0.1:${address.port}`;

		try {
			const attempt = await openCursorTransport({
				baseUrl: h2Url,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				gzipRequest: false,
				provider: "cursor",
			});
			const iter = attempt.frames()[Symbol.asyncIterator]();
			const first = await iter.next();
			expect(first.done).toBe(false);
			expect(first.value?.kind).toBe("data");
			attempt.close();
			await expect(iter.next()).rejects.toBeTruthy();
			expect(h1Hits).toBe(0);
		} finally {
			for (const session of sessions) session.destroy();
			const closing = server;
			server = undefined;
			const closed = Promise.withResolvers<void>();
			closing.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});
});
