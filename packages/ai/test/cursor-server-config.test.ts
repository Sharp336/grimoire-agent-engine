import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as http2 from "node:http2";
import { __cursorH2PoolSnapshot, acquireCursorH2, disposeCursorH2Pool } from "@oh-my-pi/pi-ai/providers/cursor/h2-pool";
import { buildCursorUnaryHeaders } from "@oh-my-pi/pi-ai/providers/cursor/headers";
import type { CursorBidiAvailability } from "@oh-my-pi/pi-ai/providers/cursor/server-config";
import {
	__cursorServerConfigCacheSize,
	fetchCursorBidiAvailability,
	readServerConfigResponse,
	resetCursorServerConfigCache,
} from "@oh-my-pi/pi-ai/providers/cursor/server-config";
import {
	type GetServerConfigResponse,
	GetServerConfigResponseSchema,
	Http2Config,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const GET_SERVER_CONFIG_PATH = "/agent.v1.AgentService/GetServerConfig";
const CONNECT_END_STREAM_FLAG = 0b00000010;

type Scenario =
	| { kind: "bidi-disabled" }
	| { kind: "all-disabled" }
	| { kind: "absent-directive" }
	| { kind: "http-500" }
	| { kind: "hang" }
	| { kind: "oversized" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = { kind: "absent-directive" };
let invocations = 0;

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function responseFrame(value: Partial<GetServerConfigResponse>): Buffer {
	const message = create(GetServerConfigResponseSchema, value);
	return frameConnectMessage(toBinary(GetServerConfigResponseSchema, message));
}

/** Clean end-of-stream envelope (no `error`, so the decoder reports a clean end). */
function endFrame(): Buffer {
	return frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG);
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		// Writing to a stream the client already destroyed emits an error on the
		// server side; swallow it so the closed-leak test does not surface one.
		stream.on("error", () => {});
		if (headers[":path"] !== GET_SERVER_CONFIG_PATH) {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		invocations++;
		if (scenario.kind === "http-500") {
			stream.respond({ ":status": 500 });
			stream.end();
			return;
		}
		if (scenario.kind === "hang") {
			// Accept the body, never respond: the client must fail open on abort.
			return;
		}
		if (scenario.kind === "oversized") {
			// A single data frame > 1 MiB exercises the cumulative decoded-byte
			// cap: the per-frame cap (16 MiB) does not catch it, but the
			// cumulative cap (1 MiB) does. The client must destroy the stream
			// and fail open.
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.write(frameConnectMessage(Buffer.alloc(1_048_577)));
			stream.write(endFrame());
			stream.end();
			return;
		}
		stream.respond({
			":status": 200,
			"content-type": "application/proto",
		});
		const config =
			scenario.kind === "bidi-disabled"
				? { http2Config: Http2Config.FORCE_BIDI_DISABLED }
				: scenario.kind === "all-disabled"
					? { http2Config: Http2Config.FORCE_ALL_DISABLED }
					: {};
		stream.write(Buffer.concat([responseFrame(config), endFrame()]));
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

async function stopServer(): Promise<void> {
	for (const session of sessions) {
		session.destroy();
	}
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	await closed.promise;
}

beforeEach(async () => {
	scenario = { kind: "absent-directive" };
	invocations = 0;
	await disposeCursorH2Pool();
	resetCursorServerConfigCache();
});

afterEach(async () => {
	await disposeCursorH2Pool();
	await stopServer();
	setSystemTime();
});

async function fetchFor(baseUrl: string, signal?: AbortSignal): Promise<CursorBidiAvailability> {
	return fetchCursorBidiAvailability({ apiKey: "test-token", baseUrl, signal });
}

describe("fetchCursorBidiAvailability", () => {
	it("maps FORCE_BIDI_DISABLED to bidi-disabled", async () => {
		scenario = { kind: "bidi-disabled" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
	});

	it("maps FORCE_ALL_DISABLED to all-disabled", async () => {
		scenario = { kind: "all-disabled" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("all-disabled");
	});

	it("returns unspecified when the directive is absent", async () => {
		scenario = { kind: "absent-directive" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
	});

	it("fails open to unspecified on a non-2xx status", async () => {
		scenario = { kind: "http-500" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
	});

	it("fails open to unspecified when aborted mid-request", async () => {
		scenario = { kind: "hang" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const pending = fetchFor(baseUrl, controller.signal);
		controller.abort();
		expect(await pending).toBe("unspecified");
	});

	it("caches per apiKey within the TTL: two calls make one wire request", async () => {
		scenario = { kind: "absent-directive" };
		const baseUrl = await startServer();
		const first = await fetchFor(baseUrl);
		const second = await fetchFor(baseUrl);
		expect(first).toBe("unspecified");
		expect(second).toBe("unspecified");
		expect(invocations).toBe(1);
	});

	it("caches the resolved value, not just the wire result", async () => {
		scenario = { kind: "bidi-disabled" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
		// Re-scenario the fixture so a second round-trip would disagree: the cache
		// must serve the first answer.
		scenario = { kind: "all-disabled" };
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
		expect(invocations).toBe(1);
	});

	it("releases the lease when the acquired stream is closed before handlers install", async () => {
		const baseUrl = await startServer();
		const acquisition = await acquireCursorH2({
			baseUrl,
			requestPath: GET_SERVER_CONFIG_PATH,
			headers: buildCursorUnaryHeaders({ apiKey: "test-token" }),
			provider: "cursor",
			signal: AbortSignal.timeout(5000),
		});
		expect(acquisition.ok).toBe(true);
		if (!acquisition.ok) return;
		// Simulate the pool (or a peer) closing the issued request stream in the
		// window between acquisition and handler installation: destroy it
		// synchronously, then hand it to the reader. This deterministically
		// exercises the `request.closed || request.destroyed` early-return — the
		// branch that previously returned "unspecified" without releasing the
		// lease, leaking the draining pool entry forever.
		acquisition.lease.request.destroy();
		const availability = await readServerConfigResponse(acquisition.lease);
		expect(availability).toBe("unspecified");
	});

	it("scopes the cache by apiKey + baseUrl, not apiKey alone", async () => {
		// Same apiKey against endpoint A (bidi-disabled) then B (all-disabled)
		// within the TTL: B must make its own wire fetch and get B's policy,
		// not A's cached answer.
		scenario = { kind: "bidi-disabled" };
		const baseUrlA = await startServer();
		expect(await fetchFor(baseUrlA)).toBe("bidi-disabled");
		expect(invocations).toBe(1);

		await stopServer();
		await disposeCursorH2Pool();
		scenario = { kind: "all-disabled" };
		const baseUrlB = await startServer();
		expect(await fetchFor(baseUrlB)).toBe("all-disabled");
		// B made its own wire request — it was not served from A's cache entry.
		expect(invocations).toBe(2);
	});

	it("fails open to unspecified when the cumulative response exceeds 1 MiB", async () => {
		scenario = { kind: "oversized" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
		// The stream was destroyed to stop consumption; the lease must be released.
		expect(__cursorH2PoolSnapshot().reduce((n, entry) => n + entry.outstanding, 0)).toBe(0);
	});

	it("bounds the cache at 8 entries (LRU) and prunes expired entries on write", async () => {
		scenario = { kind: "absent-directive" };
		const baseUrl = await startServer();
		// Insert 9 distinct keys (same baseUrl, distinct apiKeys). The cap is 8,
		// so the LRU evicts the oldest after the 9th insert.
		for (let i = 0; i < 9; i++) {
			await fetchCursorBidiAvailability({ apiKey: `key-${i}`, baseUrl });
		}
		expect(__cursorServerConfigCacheSize()).toBe(8);

		// Advance past the TTL so every existing entry is expired, then insert
		// one more. The write prunes all expired entries before setting the new
		// one, leaving exactly 1 entry.
		setSystemTime(new Date(Date.now() + 31_000));
		await fetchCursorBidiAvailability({ apiKey: `key-fresh`, baseUrl });
		expect(__cursorServerConfigCacheSize()).toBe(1);
	});
});
