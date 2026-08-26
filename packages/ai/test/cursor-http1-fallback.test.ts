import { afterEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import { ConnectProtocolError, encodeConnectFrame } from "../src/providers/cursor/connect-frame";
import { openCursorHttp1Bridge } from "../src/providers/cursor/http1-bridge";

const RUN_PATH = "/agent.v1.AgentService/Run";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const API_KEY = "http1-fallback-key";

let server: http.Server | undefined;
let appendHits = 0;
let pollHits = 0;

type PollPlan =
	| { kind: "success" }
	| { kind: "gap" }
	| { kind: "fail-after-first" }
	| { kind: "eof-without-end" }
	| { kind: "first-nonzero" };

let plan: PollPlan = { kind: "success" };
let appendStatus = 200;

// Fixture gates: when armed, append responses are held until released and the
// poll body is held until released, so tests can drive interleavings that a
// plain immediate-response server cannot express.
let holdAppendResponses = false;
const heldAppendResponses: http.ServerResponse[] = [];
function releaseAllHeldAppends(): void {
	for (const res of heldAppendResponses.splice(0)) res.end();
}
let holdPollResponse = false;
let pendingPoll: (() => void) | undefined;
function releasePoll(): void {
	const respond = pendingPoll;
	pendingPoll = undefined;
	respond?.();
}
/** Yield to the event loop once so queued IO/microtasks make progress (no wall-clock wait). */
function nextTick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
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

async function startServer(): Promise<string> {
	appendHits = 0;
	pollHits = 0;
	server = http.createServer((req, res) => {
		const url = req.url ?? "";
		if (url.includes("BidiAppend")) {
			appendHits++;
			res.statusCode = appendStatus;
			if (holdAppendResponses) {
				heldAppendResponses.push(res);
				return;
			}
			res.end();
			return;
		}
		if (url.includes("RunPoll")) {
			pollHits++;
			if (plan.kind === "success") {
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(0n, Buffer.from("hello-frame").toString("base64"), false), false),
					encodeConnectFrame(encodePollResponse(1n, Buffer.from("bye-frame").toString("base64"), true), false),
					frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG),
				]);
				const respond = (): void => {
					res.writeHead(200, { "content-type": "application/connect+proto" });
					res.end(body);
				};
				if (holdPollResponse) {
					pendingPoll = respond;
					return;
				}
				respond();
				return;
			}
			if (plan.kind === "eof-without-end") {
				// The poll eof flag arrives but the Connect end-of-stream envelope
				// never does — the turn must not settle as a clean end.
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(0n, Buffer.from("only-frame").toString("base64"), true), false),
				]);
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.end(body);
				return;
			}
			if (plan.kind === "first-nonzero") {
				// The first poll response carries a nonzero seqno, which the
				// validated first-value check must reject.
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(1n, Buffer.from("bad").toString("base64"), true), false),
					frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG),
				]);
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.end(body);
				return;
			}
			if (plan.kind === "gap") {
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(0n, Buffer.from("first").toString("base64"), false), false),
					encodeConnectFrame(encodePollResponse(2n, Buffer.from("skipped").toString("base64"), false), false),
					frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG),
				]);
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.end(body);
				return;
			}
			// fail-after-first: deliver one frame, then abort the socket mid-stream.
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(
				encodeConnectFrame(encodePollResponse(0n, Buffer.from("only-frame").toString("base64"), false), false),
			);
			setTimeout(() => {
				req.socket.destroy();
			}, 20);
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected http1 fixture to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

afterEach(async () => {
	await stopServer();
	appendStatus = 200;
});

describe("cursor HTTP/1.1 poll bridge", () => {
	it("completes a turn end-to-end over append + poll", async () => {
		plan = { kind: "success" };
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));

		const frames = [];
		for await (const frame of bridge.frames()) frames.push(frame);
		expect(frames.filter(frame => frame.kind === "data")).toHaveLength(2);
		expect(frames.at(-1)?.kind).toBe("end");
		await expect(bridge.trailers()).resolves.toEqual({});
		expect(appendHits).toBe(1);
		expect(pollHits).toBe(1);
		bridge.close();
	});

	it("treats a poll sequence gap as ConnectProtocolError, not a clean close", async () => {
		plan = { kind: "gap" };
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));

		let sawData = false;
		let error: unknown;
		try {
			for await (const frame of bridge.frames()) {
				if (frame.kind === "data") sawData = true;
			}
		} catch (cause) {
			error = cause;
		}
		expect(sawData).toBe(true);
		expect(error).toBeInstanceOf(ConnectProtocolError);
		expect(String(error)).toContain("gap");
		await expect(bridge.trailers()).rejects.toBeInstanceOf(ConnectProtocolError);
		expect(pollHits).toBe(1);
	});

	it("surfaces a later poll failure after the first frame instead of resetting the attempt", async () => {
		plan = { kind: "fail-after-first" };
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));

		const iter = bridge.frames()[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(first.value?.kind).toBe("data");
		await expect(iter.next()).rejects.toBeTruthy();
		await expect(bridge.trailers()).rejects.toBeTruthy();
		// A reset would have opened a second poll; the bridge must keep the same attempt.
		expect(pollHits).toBe(1);
		bridge.close();
	});

	it("rejects a poll EOF that never delivered the Connect end-of-stream envelope", async () => {
		plan = { kind: "eof-without-end" };
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));

		// The console body ends after the poll eof flag without the terminal
		// envelope; the attempt must surface a ConnectProtocolError, not a clean end.
		let error: unknown;
		try {
			for await (const frame of bridge.frames()) {
				// eslint-disable-next-line no-void
				void frame;
			}
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(ConnectProtocolError);
		expect(String(error)).toContain("end-of-stream");
		await expect(bridge.trailers()).rejects.toBeInstanceOf(ConnectProtocolError);
		expect(pollHits).toBe(1);
		bridge.close();
	});

	it("settles as a failure when the initial append fails, so poll success cannot mask it", async () => {
		plan = { kind: "success" }; // the poll would happily report an EOF
		appendStatus = 500;
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));

		await expect(bridge.trailers()).rejects.toBeTruthy();
		let error: unknown;
		try {
			for await (const _frame of bridge.frames()) {
				// no frames expected; the first append rejection settles the attempt
			}
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeTruthy();
		expect(appendHits).toBe(1);
		bridge.close();
	});

	it("rejects a first poll response with a nonzero seqno instead of accepting it silently", async () => {
		plan = { kind: "first-nonzero" };
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));

		let error: unknown;
		try {
			for await (const frame of bridge.frames()) {
				// eslint-disable-next-line no-void
				void frame;
			}
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(ConnectProtocolError);
		expect(String(error)).toContain("sequence violation");
		await expect(bridge.trailers()).rejects.toBeInstanceOf(ConnectProtocolError);
		expect(pollHits).toBe(1);
		bridge.close();
	});

	it("keeps poll request count at zero until the initial append response arrives", async () => {
		// Finding 1: the poll IIFE must not race ahead of the initial append.
		// Gate the append response; while it is held, no poll request may issue.
		plan = { kind: "success" };
		holdAppendResponses = true;
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("client-request"), false));
		// Wait for the append request to be received (its response is still held).
		while (appendHits < 1) await nextTick();
		// The initial append response has not been delivered yet: the poll must
		// not have started. Previously the poll awaited an already-resolved
		// `appendTail` and issued immediately, so pollHits would already be > 0.
		expect(pollHits).toBe(0);
		// Release the append response; the poll may now start and the turn completes.
		releaseAllHeldAppends();
		const frames = [];
		for await (const frame of bridge.frames()) frames.push(frame);
		expect(frames.at(-1)?.kind).toBe("end");
		await expect(bridge.trailers()).resolves.toEqual({});
		expect(appendHits).toBe(1);
		expect(pollHits).toBe(1);
		bridge.close();
	});

	it("surfaces an error to a write() issued after append admission closes at terminal settle", async () => {
		// Finding 2: at end-envelope settlement the bridge drains the append chain.
		// Before draining, append admission is closed atomically so a late write()
		// surfaces an error to ITS caller instead of being silently orphaned by the
		// abort that follows settleSuccess. We hold append #1 forever so the drain
		// stays pending and admission stays closed, then prove a crossing write throws.
		plan = { kind: "success" };
		holdAppendResponses = true;
		holdPollResponse = true;
		const baseUrl = await startServer();
		const bridge = openCursorHttp1Bridge({
			baseUrl,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			gzipRequest: false,
		});
		bridge.write(encodeConnectFrame(Buffer.from("frameA"), false));
		while (appendHits < 1) await nextTick();
		releaseAllHeldAppends(); // append #0 settles → poll may start
		bridge.write(encodeConnectFrame(Buffer.from("frameB"), false)); // append #1, held
		while (appendHits < 2) await nextTick();
		while (pollHits < 1) await nextTick();
		releasePoll(); // deliver eof + end-of-stream envelope → reader drains on append #1
		// The drain blocks on held append #1, so admission closes once and stays
		// closed. Retry the write until it throws: a crossing write must error.
		let admissionClosed = false;
		for (let i = 0; i < 200 && !admissionClosed; i++) {
			try {
				bridge.write(encodeConnectFrame(Buffer.from("frameC"), false));
			} catch {
				admissionClosed = true;
				break;
			}
			await nextTick();
		}
		expect(admissionClosed).toBe(true);
		// No orphaned append #2 was silently aborted: only #0 and #1 were issued.
		expect(appendHits).toBe(2);
		releaseAllHeldAppends();
		bridge.close();
	});
});
