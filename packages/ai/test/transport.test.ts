import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import * as https from "node:https";
import * as net from "node:net";
import { gzipSync } from "node:zlib";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { Http2SessionManager } from "@connectrpc/connect-node";
import * as publicTransport from "@oh-my-pi/pi-ai/transport";
import {
	acquireH2Session,
	CONNECT_COMPRESSED_FLAG,
	CONNECT_END_STREAM_FLAG,
	type ConnectFrame,
	createConnectFrameReader,
	createHttp1Bridge,
	disposeH2Pool,
	encodeConnectFrame,
	getH2PoolSizeForTest,
	isTransientTransportError,
	normalizeConnectAuthError,
	postH2Only,
	postH2Primary,
	readConnectTrailerError,
} from "@oh-my-pi/pi-ai/transport";
import { __resetExtraCaCache } from "@oh-my-pi/pi-utils";
import { CursorCredentialError, ProviderHttpError } from "../src/error";
import * as proxyUtils from "../src/utils/proxy";

const servers = new Set<http2.Http2Server>();

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		[...servers].map(server => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		}),
	);
	servers.clear();
});

function abortPromise(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	const aborted = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
	return aborted.promise;
}

async function listen(
	onStream: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
): Promise<{ baseUrl: string; server: http2.Http2Server }> {
	const server = http2.createServer();
	servers.add(server);
	server.on("stream", onStream);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => resolve());
	await promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP/2 test server has no TCP address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function readAll(stream: http2.ClientHttp2Stream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function fetchSpy(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
	return Object.assign(implementation, { preconnect: fetch.preconnect });
}

async function runInIsolatedProcess(testName: string): Promise<boolean> {
	if (Bun.env.OMP_ISOLATED_H2_MANAGER_TEST === "1") return false;
	const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", testName], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, TMPDIR: "/dev/shm", OMP_ISOLATED_H2_MANAGER_TEST: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`${stderr}\n${stdout}`);
	return true;
}

describe("shared Connect framing", () => {
	it("decodes fragmented and compressed frames without losing boundaries", () => {
		const first = encodeConnectFrame(new TextEncoder().encode("alpha"));
		const compressed = encodeConnectFrame(gzipSync("beta"), CONNECT_COMPRESSED_FLAG | CONNECT_END_STREAM_FLAG);
		const wire = Buffer.concat([first, compressed]);
		const reader = createConnectFrameReader();
		expect(reader.push(wire.subarray(0, 3))).toEqual([]);
		const frames = reader.push(wire.subarray(3));
		expect(frames.map(frame => new TextDecoder().decode(frame.payload))).toEqual(["alpha", "beta"]);
		expect(frames.map(frame => frame.endOfStream)).toEqual([false, true]);
	});

	it("decodes a large frame fragmented into tiny chunks", () => {
		const payload = new Uint8Array(2 * 1024 * 1024).fill(0x5a);
		const wire = encodeConnectFrame(payload, CONNECT_END_STREAM_FLAG);
		const reader = createConnectFrameReader();
		let frames: ConnectFrame[] = [];
		for (let offset = 0; offset < wire.byteLength; offset += 1024) {
			frames = frames.concat(reader.push(wire.subarray(offset, offset + 1024)));
		}
		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload).toEqual(payload);
		expect(() => reader.finish()).not.toThrow();
	});

	it("rejects a declared payload above the configured bound before buffering it", () => {
		const frame = encodeConnectFrame(new Uint8Array(9));
		const reader = createConnectFrameReader({ maxPayloadBytes: 8 });
		expect(() => reader.push(frame.subarray(0, 5))).toThrow("exceeds 8 bytes");
	});

	it("rejects a clean close with a truncated Connect header", () => {
		const reader = createConnectFrameReader();
		expect(reader.push(new Uint8Array([0, 0, 0]))).toEqual([]);
		expect(() => reader.finish()).toThrow("incomplete frame header (3 of 5 bytes)");
	});

	it("rejects a clean close with a truncated Connect payload", () => {
		const reader = createConnectFrameReader();
		const frame = encodeConnectFrame(new Uint8Array([1, 2, 3]));
		expect(reader.push(frame.subarray(0, -1))).toEqual([]);
		expect(() => reader.finish()).toThrow("incomplete frame payload (2 of 3 bytes)");
	});

	it("accepts a complete terminal frame at a clean close", () => {
		const reader = createConnectFrameReader();
		const frames = reader.push(encodeConnectFrame(new Uint8Array(0), CONNECT_END_STREAM_FLAG));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.endOfStream).toBe(true);
		reader.finish();
	});

	it("extracts structured trailer errors and ignores successful trailers", () => {
		const error = new TextEncoder().encode(
			JSON.stringify({ error: { code: "permission_denied", message: "account unavailable" } }),
		);
		expect(readConnectTrailerError(error)).toEqual({ code: "permission_denied", message: "account unavailable" });
		expect(readConnectTrailerError(new TextEncoder().encode("{}"))).toBeNull();
	});

	it("rejects malformed terminal JSON but ignores forward-compatible top-level fields", () => {
		expect(() => readConnectTrailerError(new TextEncoder().encode("{"))).toThrow("malformed JSON");
		expect(readConnectTrailerError(new TextEncoder().encode('{"unexpected":true}'))).toBeNull();
		expect(
			readConnectTrailerError(
				new TextEncoder().encode('{"unexpected":{"version":2},"error":{"code":"unavailable","message":"retry"}}'),
			),
		).toEqual({ code: "unavailable", message: "retry" });
	});

	it("rejects duplicate EOS, data after EOS, unknown flags, and EOF without EOS", () => {
		const terminal = encodeConnectFrame(new Uint8Array(0), CONNECT_END_STREAM_FLAG);
		const reader = createConnectFrameReader();
		reader.push(terminal);
		expect(() => reader.push(terminal)).toThrow("duplicate end-of-stream");

		const combined = createConnectFrameReader();
		expect(() => combined.push(Buffer.concat([terminal, encodeConnectFrame(new Uint8Array([1]))]))).toThrow(
			"data after end-of-stream",
		);

		const unknown = encodeConnectFrame(new Uint8Array(0), 0x80);
		expect(() => createConnectFrameReader().push(unknown)).toThrow("unknown flags");

		const missing = createConnectFrameReader();
		missing.push(encodeConnectFrame(new Uint8Array([1])));
		expect(() => missing.finish()).toThrow("without end-of-stream");
	});
});

describe("shared HTTP/1 bridge", () => {
	it("makes concurrent close callers await the same in-flight append drain", async () => {
		const appendStarted = Promise.withResolvers<void>();
		const appendAborted = Promise.withResolvers<void>();
		const releaseAppend = Promise.withResolvers<void>();
		const bridge = await createHttp1Bridge({
			baseUrl: "http://127.0.0.1",
			provider: "transport-test",
			headers: {},
			requestBytes: new Uint8Array([1]),
			createRpc(_transport: Transport) {
				return {
					async append(_seqno, _data, signal) {
						appendStarted.resolve();
						try {
							await abortPromise(signal);
						} catch {
							appendAborted.resolve();
							await releaseAppend.promise;
							throw new Error("append aborted");
						}
					},
					async *receive(signal) {
						await abortPromise(signal);
						yield* [];
					},
					async *poll() {
						yield* [];
					},
					decodePoll(data) {
						return data;
					},
				};
			},
		});
		await appendStarted.promise;
		const firstClose = bridge.close("dispose");
		await appendAborted.promise;
		let secondClosed = false;
		const secondClose = bridge.close("dispose").then(() => {
			secondClosed = true;
		});
		await Promise.resolve();
		expect(secondClosed).toBeFalse();
		releaseAppend.resolve();
		await Promise.all([firstClose, secondClose]);
	});

	it("does not decode or re-enqueue an accepted poll retransmission", async () => {
		let executions = 0;
		const bridge = await createHttp1Bridge({
			baseUrl: "http://127.0.0.1",
			provider: "transport-test",
			headers: {},
			requestBytes: new Uint8Array(),
			createRpc() {
				return {
					async append() {},
					async *receive() {
						yield* [];
					},
					async *poll() {
						yield { seqno: 0n, data: "exec-0", eof: false };
						yield { seqno: 0n, data: "exec-0", eof: false };
						yield { seqno: 1n, data: "exec-1", eof: true };
					},
					decodePoll(data) {
						executions++;
						return data;
					},
				};
			},
		});
		const messages: string[] = [];
		for await (const message of bridge.messages) messages.push(message);
		expect(messages).toEqual(["exec-0", "exec-1"]);
		expect(executions).toBe(2);
	});

	it("rejects poll streams that end before an EOF frame", async () => {
		for (const frames of [[], [{ seqno: 0n, data: "partial", eof: false }]]) {
			const bridge = await createHttp1Bridge({
				baseUrl: "http://127.0.0.1",
				provider: "transport-test",
				headers: {},
				requestBytes: new Uint8Array(),
				createRpc() {
					return {
						async append() {},
						async *receive() {
							yield* [];
						},
						async *poll() {
							yield* frames;
						},
						decodePoll(data) {
							return data;
						},
					};
				},
			});
			const iterator = bridge.messages[Symbol.asyncIterator]();
			if (frames.length > 0) expect(await iterator.next()).toEqual({ value: "partial", done: false });
			await expect(iterator.next()).rejects.toThrow("poll stream ended before EOF frame");
		}
	});

	it("surfaces poll sequence violations as fatal errors", async () => {
		const bridge = await createHttp1Bridge({
			baseUrl: "http://127.0.0.1",
			provider: "transport-test",
			headers: {},
			requestBytes: new Uint8Array(),
			createRpc() {
				return {
					async append() {},
					async *receive() {
						yield* [];
					},
					async *poll() {
						yield { seqno: 0n, data: "first", eof: false };
						yield { seqno: 2n, data: "gap", eof: false };
					},
					decodePoll(data) {
						return data;
					},
				};
			},
		});
		const iterator = bridge.messages[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({ value: "first", done: false });
		await expect(iterator.next()).rejects.toThrow("poll sequence violation");
	});

	it("surfaces receive and poll failures instead of ending normally", async () => {
		for (const failureAt of ["receive", "poll"] as const) {
			const fatal = new Error(`${failureAt} failed`);
			const bridge = await createHttp1Bridge({
				baseUrl: "http://127.0.0.1",
				provider: "transport-test",
				headers: {},
				requestBytes: new Uint8Array(),
				createRpc() {
					return {
						async append() {},
						async *receive() {
							if (failureAt === "receive") throw fatal;
							yield* [];
						},
						async *poll() {
							if (failureAt === "poll") throw fatal;
							yield* [];
						},
						decodePoll(data) {
							return data;
						},
					};
				},
			});
			const iterator = bridge.messages[Symbol.asyncIterator]();
			await expect(iterator.next()).rejects.toBe(fatal);
		}
	});

	it("normalizes authentication failures at every RPC boundary to a status-bearing credential error", async () => {
		for (const failureAt of ["append", "receive", "poll"] as const) {
			const bridge = await createHttp1Bridge({
				baseUrl: "http://127.0.0.1",
				provider: "transport-test",
				headers: {},
				requestBytes: new Uint8Array(),
				normalizeError: error =>
					normalizeConnectAuthError(
						error,
						(message, status) => new CursorCredentialError(message, status),
						(message, status) => new ProviderHttpError(message, status),
					),
				createRpc() {
					return {
						async append() {
							if (failureAt === "append") throw new ConnectError("denied", Code.Unauthenticated);
						},
						async *receive(signal) {
							if (failureAt === "receive") throw new ConnectError("denied", Code.Unauthenticated);
							if (failureAt === "append") await abortPromise(signal);
							yield* [];
						},
						async *poll() {
							if (failureAt === "poll") throw new ConnectError("denied", Code.Unauthenticated);
							yield* [];
						},
						decodePoll(data) {
							return data;
						},
					};
				},
			});
			try {
				await bridge.messages[Symbol.asyncIterator]().next();
			} catch (error) {
				expect(error).toBeInstanceOf(CursorCredentialError);
				expect((error as CursorCredentialError).status).toBe(401);
				continue;
			}
			throw new Error(`Expected an authentication failure from ${failureAt}`);
		}
	});
});

describe("shared HTTP/2 pool", () => {
	it("leases pooled sessions and safely releases a lease twice", async () => {
		const sessions: http2.ServerHttp2Session[] = [];
		const { baseUrl, server } = await listen((stream, headers) => {
			expect(headers.te).toBe("trailers");
			stream.respond({ ":status": 200 });
			stream.end("ok");
		});
		server.on("session", session => sessions.push(session));

		const leases = await Promise.all(Array.from({ length: 5 }, () => acquireH2Session(baseUrl, "transport-test")));
		for (const lease of leases) {
			const request = await lease.request({ ":method": "POST", ":path": "/run" });
			request.end();
			expect(await readAll(request)).toBe("ok");
		}
		for (const lease of leases) {
			lease.release();
			lease.release();
		}
		expect(sessions).toHaveLength(1);
	});

	it("keeps a healthy slot alive while another acquisition is connecting", async () => {
		const { baseUrl } = await listen(stream => {
			stream.respond({ ":status": 200 });
			stream.end("ok");
		});
		const first = await acquireH2Session(baseUrl, "transport-test");
		const abort = vi.spyOn(Http2SessionManager.prototype, "abort");
		const connecting = Promise.withResolvers<"open">();
		const connectStarted = Promise.withResolvers<void>();
		vi.spyOn(Http2SessionManager.prototype, "connect").mockImplementation(() => {
			connectStarted.resolve();
			return connecting.promise;
		});

		const acquiring = acquireH2Session(baseUrl, "transport-test");
		await connectStarted.promise;
		first.release();
		expect(abort).not.toHaveBeenCalled();
		connecting.resolve("open");
		const second = await acquiring;
		const request = await second.request({ ":method": "POST", ":path": "/reserved" });
		request.end();
		expect(await readAll(request)).toBe("ok");
		second.release();
	});

	it("retires a session initializer after its final waiter aborts", async () => {
		if (await runInIsolatedProcess("retires a session initializer after its final waiter aborts")) return;
		const connecting = Promise.withResolvers<"open">();
		const connectStarted = Promise.withResolvers<void>();
		const abort = vi.spyOn(Http2SessionManager.prototype, "abort").mockImplementation(() => {});
		vi.spyOn(Http2SessionManager.prototype, "connect").mockImplementation(() => {
			connectStarted.resolve();
			return connecting.promise;
		});
		const controller = new AbortController();
		const acquiring = acquireH2Session("https://abandoned.example", "transport-test", {
			signal: controller.signal,
		});
		await connectStarted.promise;
		controller.abort();
		await expect(acquiring).rejects.toThrow();
		connecting.resolve("open");
		await Promise.resolve();
		await Promise.resolve();
		expect(abort).toHaveBeenCalledTimes(1);
	});
	it("closes an acquired stream when abort wins after request creation", async () => {
		const { baseUrl } = await listen(stream => {
			stream.respond({ ":status": 200 });
		});
		const lease = await acquireH2Session(baseUrl, "transport-test");
		let additions = 0;
		let aborted = false;
		const targetSignal = new AbortController().signal;
		const signal = new Proxy(targetSignal, {
			get(target, property) {
				if (property === "aborted") return aborted;
				if (property === "addEventListener") {
					return (...args: Parameters<AbortSignal["addEventListener"]>) => {
						additions++;
						if (additions === 2) aborted = true;
						target.addEventListener(...args);
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(lease.request({ ":method": "POST", ":path": "/race" }, { signal })).rejects.toThrow();
		expect(additions).toBe(2);
	});

	it("tries only one fresh slot when HTTP/2 establishment fails", async () => {
		let connections = 0;
		const server = net.createServer(socket => {
			connections++;
			socket.destroy();
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("expected TCP fixture port");
			await expect(acquireH2Session(`https://127.0.0.1:${address.port}`, "transport-test")).rejects.toThrow();
			expect(connections).toBe(1);
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
	});

	it("evicts a pool entry after its only initializer fails", async () => {
		expect(getH2PoolSizeForTest()).toBe(0);
		const server = net.createServer(socket => socket.destroy());
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("expected TCP fixture port");
			await expect(acquireH2Session(`https://127.0.0.1:${address.port}`, "pool-eviction-test")).rejects.toThrow();
			expect(getH2PoolSizeForTest()).toBe(0);
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
	});

	it("evicts an idle manager when its final lease is released", async () => {
		let sessionCount = 0;
		const sessionClosed = Promise.withResolvers<void>();
		const { baseUrl, server } = await listen(stream => {
			stream.respond({ ":status": 200 });
			stream.end("ok");
		});
		server.on("session", session => {
			sessionCount++;
			if (sessionCount === 1) session.once("close", sessionClosed.resolve);
		});
		const lease = await acquireH2Session(baseUrl, "transport-test");
		const request = await lease.request({ ":method": "POST", ":path": "/idle" });
		request.end();
		await readAll(request);
		lease.release();
		await sessionClosed.promise;
		const next = await acquireH2Session(baseUrl, "transport-test");
		expect(sessionCount).toBe(2);
		next.release();
	});

	it("preserves the originating connection error when every slot fails", async () => {
		const { baseUrl, server } = await listen(() => {});
		const { promise: closed, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await closed;
		servers.delete(server);

		try {
			await acquireH2Session(baseUrl, "transport-test");
		} catch (error) {
			expect(error && typeof error === "object" && "code" in error ? error.code : undefined).toBe("ECONNREFUSED");
			return;
		}
		throw new Error("Expected HTTP/2 acquisition to fail");
	});

	it("disposal closes active streams before it resolves", async () => {
		if (await runInIsolatedProcess("disposal closes active streams before it resolves")) return;
		const { baseUrl } = await listen(stream => {
			stream.respond({ ":status": 200 });
		});
		const lease = await acquireH2Session(baseUrl, "transport-test");
		const request = await lease.request({ ":method": "POST", ":path": "/hang" });
		request.end();
		const { promise: closed, resolve } = Promise.withResolvers<void>();
		request.once("close", () => resolve());
		const firstDisposal = disposeH2Pool();
		const concurrentDisposal = disposeH2Pool();
		expect(concurrentDisposal).toBe(firstDisposal);
		await firstDisposal;
		await closed;
		lease.release();
		expect(request.closed || request.destroyed).toBeTrue();
	});
});

describe("shared transport lifecycle", () => {
	it("does not publish the unsafe synchronous bridge reset seam", () => {
		expect("__resetHttp1Bridges" in publicTransport).toBeFalse();
	});
	it("provider imports do not register transport cleanup", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { postmortem } from "@oh-my-pi/pi-utils";
import { isTransportDisposed } from "./src/transport/lifecycle.ts";
import "./src/providers/devin.ts";
import "./src/providers/cursor/server-config.ts";
await postmortem.cleanup();
process.stdout.write(String(isTransportDisposed()));`,
			],
			{ cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("false");
	});

	it("registers config cleanup on first lookup and clears the lookup cache", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import * as http from "node:http";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { GetServerConfigResponseSchema, ServerConfigService } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import { disposeServerConfigCache, resolveCursorTransportMode } from "./src/providers/cursor/server-config.ts";
import { registerTransportDisposer } from "./src/transport/lifecycle.ts";
let requests = 0;
const server = http.createServer(connectNodeAdapter({
	routes: router => router.service(ServerConfigService, {
		getServerConfig: () => { requests++; return create(GetServerConfigResponseSchema); },
	}),
}));
const listening = Promise.withResolvers();
server.once("error", listening.reject);
server.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = server.address();
if (!address || typeof address === "string") throw new Error("missing address");
const options = { baseUrl: "http://127.0.0.1:" + address.port, apiKey: "key", provider: "cursor" };
await resolveCursorTransportMode(options);
let registered = false;
try { registerTransportDisposer("cursor-server-config", async () => {}); } catch { registered = true; }
await disposeServerConfigCache();
await resolveCursorTransportMode(options);
const closed = Promise.withResolvers();
server.close(closed.resolve);
await closed.promise;
process.stdout.write(JSON.stringify({ registered, requests }));`,
			],
			{ cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ registered: true, requests: 2 });
	});

	it("awaits registered disposers before resolving", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { disposeTransports, isTransportDisposed, registerTransportDisposer } from "./src/transport/lifecycle.ts";
let drained = false;
registerTransportDisposer("probe", () => {
	const { promise, resolve } = Promise.withResolvers();
	queueMicrotask(() => {
		drained = true;
		resolve();
	});
	return promise;
});
await disposeTransports();
process.stdout.write(JSON.stringify({ drained, disposed: isTransportDisposed() }));`,
			],
			{ cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ drained: true, disposed: true });
	});
});

describe("shared transport classification", () => {
	it("classifies exact network failures but excludes provider status and cancellation", () => {
		expect(isTransientTransportError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBeTrue();
		expect(isTransientTransportError(Object.assign(new Error("unavailable"), { status: 503 }))).toBeFalse();
		expect(isTransientTransportError(Object.assign(new Error("forbidden"), { status: 403 }))).toBeFalse();
		expect(isTransientTransportError(new DOMException("aborted", "AbortError"))).toBeFalse();
	});
	it("maps non-auth Connect codes to status-bearing errors so transient semantics survive", () => {
		const credential = (message: string, status: 401 | 403) => new CursorCredentialError(message, status);
		const http = (message: string, status: number) => new ProviderHttpError(message, status);
		// Auth codes keep their credential-error identity.
		expect(
			normalizeConnectAuthError(new ConnectError("denied", Code.Unauthenticated), credential, http),
		).toBeInstanceOf(CursorCredentialError);
		expect(
			normalizeConnectAuthError(new ConnectError("denied", Code.PermissionDenied), credential, http),
		).toBeInstanceOf(CursorCredentialError);
		// Non-auth codes are now status-bearing so the outer classifier can derive
		// transient semantics (503/429) instead of receiving a statusless error.
		const unavailable = normalizeConnectAuthError(new ConnectError("try again", Code.Unavailable), credential, http);
		expect(unavailable).toBeInstanceOf(ProviderHttpError);
		expect((unavailable as ProviderHttpError).status).toBe(503);
		const exhausted = normalizeConnectAuthError(
			new ConnectError("resource exhausted", Code.ResourceExhausted),
			credential,
			http,
		);
		expect((exhausted as ProviderHttpError).status).toBe(429);
		// Non-Connect errors pass through untouched.
		const passthrough = new Error("boom");
		expect(normalizeConnectAuthError(passthrough, credential, http)).toBe(passthrough);
	});
});

describe("HTTP/2 primary fallback boundary", () => {
	it("attempts HTTP/1 only for typed pre-dispatch unavailability", async () => {
		let fetchAttempts = 0;
		const fetchMock = fetchSpy(async () => {
			fetchAttempts++;
			return new Response("fallback", { status: 200 });
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const unavailable = net.createServer();
		const listening = Promise.withResolvers<void>();
		unavailable.once("error", listening.reject);
		unavailable.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = unavailable.address();
		if (!address || typeof address === "string") throw new Error("expected unavailable port");
		const closed = Promise.withResolvers<void>();
		unavailable.close(() => closed.resolve());
		await closed.promise;
		const response = await postH2Primary({
			url: `http://127.0.0.1:${address.port}/dispatch`,
			provider: "transport-test",
			headers: {},
			body: "body",
		});
		expect(response.status).toBe(200);
		expect(fetchAttempts).toBe(1);
	});
	it("passes inline extra CAs to native HTTP/2 sessions", async () => {
		if (await runInIsolatedProcess("passes inline extra CAs to native HTTP/2 sessions")) return;
		const previousCa = Bun.env.NODE_EXTRA_CA_CERTS;
		Bun.env.NODE_EXTRA_CA_CERTS = "-----BEGIN CERTIFICATE-----\\nMIIB-test-extra-ca\\n-----END CERTIFICATE-----";
		__resetExtraCaCache();
		let sessionOptions: { ca?: string | string[] } | undefined;
		vi.spyOn(Http2SessionManager.prototype, "connect").mockImplementation(function (this: Http2SessionManager) {
			const options: unknown = Reflect.get(this, "http2SessionOptions");
			if (options && typeof options === "object" && "ca" in options) {
				const ca = options.ca;
				if (typeof ca === "string" || (Array.isArray(ca) && ca.every(value => typeof value === "string"))) {
					sessionOptions = { ca };
				}
			}
			return Promise.reject(Object.assign(new Error("stop after option capture"), { code: "TEST_CAPTURE" }));
		});
		try {
			await expect(
				postH2Only({
					url: "https://extra-ca.example/request",
					provider: "devin",
					headers: {},
					body: "body",
				}),
			).rejects.toThrow("stop after option capture");
			expect(sessionOptions?.ca).toContain(
				"-----BEGIN CERTIFICATE-----\nMIIB-test-extra-ca\n-----END CERTIFICATE-----",
			);
		} finally {
			if (previousCa === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
			else Bun.env.NODE_EXTRA_CA_CERTS = previousCa;
			__resetExtraCaCache();
		}
	});

	it("preserves the provider proxy on a pre-dispatch HTTP/1 fallback", async () => {
		const requests: string[] = [];
		if (await runInIsolatedProcess("preserves the provider proxy on a pre-dispatch HTTP/1 fallback")) return;
		const sockets = new Set<net.Socket>();
		const proxy = net.createServer(socket => {
			sockets.add(socket);
			socket.on("data", chunk => {
				const request = chunk.toString("latin1");
				requests.push(request);
				if (request.startsWith("CONNECT ")) {
					socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					return;
				}
				socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
			});
		});
		const listening = Promise.withResolvers<void>();
		proxy.once("error", listening.reject);
		proxy.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("expected proxy fixture port");
		const previousProxy = Bun.env.PI_PROXY_TRANSPORT_TEST;
		Bun.env.PI_PROXY_TRANSPORT_TEST = `http://127.0.0.1:${address.port}`;
		proxyUtils.__resetProxyCache();
		try {
			vi.spyOn(Http2SessionManager.prototype, "connect").mockRejectedValue(
				Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
			);
			const response = await postH2Primary({
				url: "http://provider.example/dispatch",
				provider: "transport-test",
				headers: {},
				body: "body",
			});
			expect(response.status).toBe(200);
			expect(requests.some(request => request.includes("provider.example"))).toBeTrue();
			await response.close();
		} finally {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			proxy.close(() => closed.resolve());
			await closed.promise;
			if (previousProxy === undefined) delete Bun.env.PI_PROXY_TRANSPORT_TEST;
			else Bun.env.PI_PROXY_TRANSPORT_TEST = previousProxy;
			proxyUtils.__resetProxyCache();
		}
	});

	it("never attempts HTTP/1 after request creation or body dispatch", async () => {
		let fetchAttempts = 0;
		const fetchMock = fetchSpy(async () => {
			fetchAttempts++;
			return new Response();
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		for (const phase of ["request", "body"] as const) {
			const { baseUrl } = await listen(stream => {
				if (phase === "request") {
					stream.close(http2.constants.NGHTTP2_CANCEL);
					return;
				}
				stream.once("data", () => stream.close(http2.constants.NGHTTP2_CANCEL));
			});
			await expect(
				postH2Primary({ url: `${baseUrl}/${phase}`, provider: "transport-test", headers: {}, body: "body" }),
			).rejects.toThrow();
		}
		expect(fetchAttempts).toBe(0);
	});

	it("never attempts HTTP/1 after status, frame, or trailer observation", async () => {
		let fetchAttempts = 0;
		const fetchMock = fetchSpy(async () => {
			fetchAttempts++;
			return new Response();
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		for (const phase of ["status", "frame", "trailer"] as const) {
			const { baseUrl } = await listen(stream => {
				stream.on("error", () => {});
				stream.respond({ ":status": 200 }, phase === "trailer" ? { waitForTrailers: true } : undefined);
				if (phase === "frame") stream.write(encodeConnectFrame(new Uint8Array([1])));
				if (phase === "trailer") {
					stream.once("wantTrailers", () => {
						stream.sendTrailers({ "grpc-status": "13" });
					});
					stream.end();
					return;
				}
				stream.close(http2.constants.NGHTTP2_CANCEL);
			});
			const response = await postH2Primary({
				url: `${baseUrl}/${phase}`,
				provider: "transport-test",
				headers: {},
				body: "body",
			});
			await new Response(response.body).arrayBuffer().catch(() => undefined);
			await response.close();
		}
		expect(fetchAttempts).toBe(0);
	});

	it("passes a bounded timeout to proxy tunnel establishment", async () => {
		const previousProxy = Bun.env.PI_PROXY_TRANSPORT_TEST;
		Bun.env.PI_PROXY_TRANSPORT_TEST = "http://proxy.example:8080";
		proxyUtils.__resetProxyCache();
		let timeoutMs: number | undefined;
		vi.spyOn(proxyUtils, "createProxiedAgent").mockImplementation((_proxy, _target, options) => {
			timeoutMs = options?.timeoutMs;
			return new https.Agent();
		});
		try {
			const bridge = await createHttp1Bridge({
				baseUrl: "https://provider.example",
				provider: "transport-test",
				headers: {},
				requestBytes: new Uint8Array(),
				proxyTunnelTimeoutMs: 20,
				createRpc() {
					return {
						async append() {},
						async *receive() {
							yield* [];
						},
						async *poll() {
							yield* [];
						},
						decodePoll(data) {
							return data;
						},
					};
				},
			});
			expect(timeoutMs).toBe(20);
			await bridge.close("dispose");
		} finally {
			if (previousProxy === undefined) delete Bun.env.PI_PROXY_TRANSPORT_TEST;
			else Bun.env.PI_PROXY_TRANSPORT_TEST = previousProxy;
			proxyUtils.__resetProxyCache();
		}
	});
});
