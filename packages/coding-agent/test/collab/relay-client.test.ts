/**
 * Contract: CollabSocket.send backpressure and drain-timer lifecycle.
 *
 * (a) Frames enqueue when bufferedAmount >= 64 KB high threshold.
 * (b) Queued frames flush IN ORDER before newer frames once bufferedAmount
 *     drops below the 32 KB drain threshold.
 * (c) The drain retry timer is cancelled on close (no timer leak).
 *
 * Uses a fake WebSocket with a controllable `bufferedAmount` and real short
 * timers (25 ms drain retry). Fake timers cannot be used here because
 * `seal()` calls `crypto.subtle.encrypt`, which resolves on the native thread
 * pool — its promise completion is delivered as a macro task that fake timers
 * suppress, causing the send chain to deadlock. The setTimeout(0) calls in
 * waitFor are deliberate real-timer event-loop yields (see ts-no-test-timers
 * exception): deterministic time control is not viable when native async
 * crypto operations are in the send chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { generateRoomKey, importRoomKey, open } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { unpackEnvelope } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";

const RealWebSocket = globalThis.WebSocket;

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;

	url: string;
	binaryType = "blob";
	readyState = MockWebSocket.CONNECTING;
	bufferedAmount = 0;

	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;

	sent: Uint8Array[] = [];
	closedWith: { code?: number; reason?: string } | null = null;

	static lastInstance: MockWebSocket | null = null;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.lastInstance = this;
		queueMicrotask(() => {
			if (this.readyState === MockWebSocket.CONNECTING) {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.();
			}
		});
	}

	send(data: Uint8Array | ArrayBuffer | string): void {
		if (this.readyState !== MockWebSocket.OPEN) {
			throw new Error("InvalidStateError: WebSocket is not in OPEN state");
		}
		if (data instanceof Uint8Array) {
			this.sent.push(data);
		} else if (data instanceof ArrayBuffer) {
			this.sent.push(new Uint8Array(data));
		} else {
			this.sent.push(new TextEncoder().encode(data));
		}
	}

	close(code?: number, reason?: string): void {
		this.readyState = MockWebSocket.CLOSED;
		this.closedWith = { code, reason };
		queueMicrotask(() => {
			this.onclose?.({
				code: code ?? 1000,
				reason: reason ?? "closed",
				wasClean: true,
			} as CloseEvent);
		});
	}
}

function getMockSocketInstance(): MockWebSocket {
	const ws = MockWebSocket.lastInstance;
	if (!ws) throw new Error("MockWebSocket.lastInstance is not set");
	return ws;
}

function getPayload(envelopeBytes: Uint8Array): Uint8Array {
	const unpacked = unpackEnvelope(envelopeBytes);
	if (!unpacked) throw new Error("envelope is null or invalid");
	return unpacked.payload;
}

/**
 * Yields to the real event loop via setTimeout(0). Required because
 * `crypto.subtle.encrypt` (called by `seal()`) resolves on the native thread
 * pool; its promise completion is a macro task that `await Promise.resolve()`
 * (microtask only) cannot flush.
 */
async function yieldToEventLoop(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	await promise;
}

/**
 * Polls a condition until it returns true, yielding to the real event loop
 * between checks. Throws if never satisfied within `attempts` iterations.
 */
async function waitFor<T>(fn: () => T, attempts = 100): Promise<T> {
	for (let i = 0; i < attempts; i++) {
		const result = fn();
		if (result) return result;
		await yieldToEventLoop();
	}
	throw new Error(`waitFor: condition never met after ${attempts} attempts`);
}

describe("CollabSocket backpressure and timers", () => {
	let cryptoKey: CryptoKey;

	beforeEach(async () => {
		// Deliberate documented escape hatch: MockWebSocket implements only the
		// surface CollabSocket touches; the lib.dom WebSocket constructor type is
		// not structurally satisfiable by a test fake.
		globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket;
		MockWebSocket.lastInstance = null;
		cryptoKey = await importRoomKey(generateRoomKey());
	});

	afterEach(() => {
		globalThis.WebSocket = RealWebSocket;
		vi.restoreAllMocks();
	});

	it("enqueues frames when bufferedAmount >= high threshold (64KB)", async () => {
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/test-room",
			role: "host",
			key: cryptoKey,
		});
		socket.connect();

		await waitFor(() => MockWebSocket.lastInstance?.readyState === MockWebSocket.OPEN);
		const ws = getMockSocketInstance();

		ws.bufferedAmount = 64 * 1024;

		socket.send({ t: "prompt", text: "hello, enqueued frame" });

		// Let the send chain (seal + packEnvelope) settle. The frame should be
		// queued, not sent, because bufferedAmount >= 64 KB.
		await yieldToEventLoop();
		await yieldToEventLoop();

		expect(ws.sent.length).toBe(0);

		socket.close();
	});

	it("sends frames immediately when bufferedAmount < high threshold", async () => {
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/test-room",
			role: "host",
			key: cryptoKey,
		});
		socket.connect();

		await waitFor(() => MockWebSocket.lastInstance?.readyState === MockWebSocket.OPEN);
		const ws = getMockSocketInstance();

		ws.bufferedAmount = 63 * 1024;

		socket.send({ t: "prompt", text: "send immediately" });

		await waitFor(() => ws.sent.length === 1);

		const firstSent = ws.sent[0];
		if (!firstSent) throw new Error("firstSent is undefined");
		const opened = await open(cryptoKey, getPayload(firstSent));
		expect(opened).toEqual({ t: "prompt", text: "send immediately" });

		socket.close();
	});

	it("queued frames flush in order via the drain timer when bufferedAmount drops below drain threshold", async () => {
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/test-room",
			role: "host",
			key: cryptoKey,
		});
		socket.connect();

		await waitFor(() => MockWebSocket.lastInstance?.readyState === MockWebSocket.OPEN);
		const ws = getMockSocketInstance();

		ws.bufferedAmount = 70 * 1024;

		socket.send({ t: "prompt", text: "frame 1" });
		socket.send({ t: "prompt", text: "frame 2" });

		// Let both seal() calls settle — frames should be queued, not sent.
		await yieldToEventLoop();
		await yieldToEventLoop();
		expect(ws.sent.length).toBe(0);

		// Drop below drain threshold; the 25 ms drain timer fires and flushes.
		ws.bufferedAmount = 10 * 1024;

		// waitFor yields to the event loop via setTimeout(0); after ~25 ms the
		// real drain timer fires and the queued frames flush in order.
		await waitFor(() => ws.sent.length === 2);

		const firstSent = ws.sent[0];
		const secondSent = ws.sent[1];
		if (!firstSent || !secondSent) throw new Error("sent frames are missing");

		const opened1 = await open(cryptoKey, getPayload(firstSent));
		expect(opened1).toEqual({ t: "prompt", text: "frame 1" });

		const opened2 = await open(cryptoKey, getPayload(secondSent));
		expect(opened2).toEqual({ t: "prompt", text: "frame 2" });

		socket.close();
	});

	it("flushes queued frames in order before a newer frame when a send occurs below drain threshold", async () => {
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/test-room",
			role: "host",
			key: cryptoKey,
		});
		socket.connect();

		await waitFor(() => MockWebSocket.lastInstance?.readyState === MockWebSocket.OPEN);
		const ws = getMockSocketInstance();

		ws.bufferedAmount = 70 * 1024;

		socket.send({ t: "prompt", text: "frame 1" });
		socket.send({ t: "prompt", text: "frame 2" });

		// Let both seal() calls settle — frames should be queued, not sent.
		await yieldToEventLoop();
		await yieldToEventLoop();
		expect(ws.sent.length).toBe(0);

		// Drop below drain threshold, then send a newer frame.
		ws.bufferedAmount = 10 * 1024;
		socket.send({ t: "prompt", text: "frame 3" });

		// The send chain serializes: drain(frame1, frame2) then seal+send(frame3).
		// All three should appear on the wire in send order.
		await waitFor(() => ws.sent.length === 3);

		const firstSent = ws.sent[0];
		const secondSent = ws.sent[1];
		const thirdSent = ws.sent[2];
		if (!firstSent || !secondSent || !thirdSent) throw new Error("sent frames are missing");

		const opened1 = await open(cryptoKey, getPayload(firstSent));
		expect(opened1).toEqual({ t: "prompt", text: "frame 1" });

		const opened2 = await open(cryptoKey, getPayload(secondSent));
		expect(opened2).toEqual({ t: "prompt", text: "frame 2" });

		const opened3 = await open(cryptoKey, getPayload(thirdSent));
		expect(opened3).toEqual({ t: "prompt", text: "frame 3" });

		socket.close();
	});

	it("cancels the drain retry timer on close (no timer leak)", async () => {
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/test-room",
			role: "host",
			key: cryptoKey,
		});
		socket.connect();

		await waitFor(() => MockWebSocket.lastInstance?.readyState === MockWebSocket.OPEN);
		const ws = getMockSocketInstance();

		ws.bufferedAmount = 70 * 1024;

		socket.send({ t: "prompt", text: "drain timer test" });

		// Let seal() settle and #scheduleBackpressureDrain to run.
		await yieldToEventLoop();
		await yieldToEventLoop();

		// Set up listeners for unhandled rejections/exceptions during the wait.
		let unhandledError: Error | null = null;
		const handleError = (err: unknown) => {
			unhandledError = err instanceof Error ? err : new Error(String(err));
		};
		process.on("unhandledRejection", handleError);
		process.on("uncaughtException", handleError);

		try {
			// The drain timer was scheduled; close must cancel it.
			socket.close();

			// Wait beyond the drain retry interval (25 ms)
			await Bun.sleep(50);

			// Assert that no frame was sent on the dead socket (since it was closed)
			expect(ws.sent.length).toBe(0);
			expect(unhandledError).toBeNull();
		} finally {
			process.off("unhandledRejection", handleError);
			process.off("uncaughtException", handleError);
		}
	});
});
