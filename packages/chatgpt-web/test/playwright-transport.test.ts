import { describe, expect, test } from "bun:test";
import { type Browser, type ConnectOverCDPTransport, chromium } from "playwright-core";
import { createPlaywrightPipeTransport, type NativeBrowserPipeLike } from "../src/runtime/playwright-transport";

const PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

type ReadEvent = { kind: "chunk"; bytes: Uint8Array } | { kind: "end" } | { kind: "error"; error: unknown };

interface ReadWaiter {
	resolve(result: IteratorResult<Uint8Array>): void;
	reject(error: unknown): void;
}

class FakeBrowserPipe implements NativeBrowserPipeLike {
	readonly nonBlocking = true as const;
	readonly writes: Uint8Array[] = [];
	closeCalls = 0;
	writeAttempts = 0;
	writeFailure: unknown;

	readonly #events: ReadEvent[] = [];
	readonly #readWaiters: ReadWaiter[] = [];
	readonly #writeWaiters: Array<{ count: number; resolve(): void }> = [];
	#ended = false;
	#readClaimed = false;

	read(): AsyncIterable<Uint8Array> {
		if (this.#readClaimed) throw new Error("Fake pipe read side was claimed twice");
		this.#readClaimed = true;
		return {
			[Symbol.asyncIterator]: () => ({ next: () => this.#nextRead() }),
		};
	}

	async write(bytes: Uint8Array): Promise<void> {
		this.writeAttempts++;
		if (this.writeFailure !== undefined) throw this.writeFailure;
		this.writes.push(bytes.slice());
		for (let index = this.#writeWaiters.length - 1; index >= 0; index--) {
			const waiter = this.#writeWaiters[index];
			if (this.writes.length < waiter.count) continue;
			this.#writeWaiters.splice(index, 1);
			waiter.resolve();
		}
	}

	async close(): Promise<void> {
		this.closeCalls++;
		this.end();
	}

	push(bytes: Uint8Array): void {
		this.#enqueue({ kind: "chunk", bytes: bytes.slice() });
	}

	fail(error: unknown): void {
		this.#enqueue({ kind: "error", error });
	}

	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#enqueue({ kind: "end" });
	}

	waitForWrites(count: number): Promise<void> {
		if (this.writes.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#writeWaiters.push({ count, resolve });
		return promise;
	}

	#enqueue(event: ReadEvent): void {
		if (event.kind === "chunk" && this.#ended) throw new Error("Cannot push after fake EOF");
		const waiter = this.#readWaiters.shift();
		if (!waiter) {
			this.#events.push(event);
			return;
		}
		if (event.kind === "chunk") waiter.resolve({ value: event.bytes, done: false });
		else if (event.kind === "error") waiter.reject(event.error);
		else waiter.resolve({ value: undefined, done: true });
	}

	#nextRead(): Promise<IteratorResult<Uint8Array>> {
		const event = this.#events.shift();
		if (event) {
			if (event.kind === "chunk") return Promise.resolve({ value: event.bytes, done: false });
			if (event.kind === "error") return Promise.reject(event.error);
			return Promise.resolve({ value: undefined, done: true });
		}
		if (this.#ended) return Promise.resolve({ value: undefined, done: true });
		const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<Uint8Array>>();
		this.#readWaiters.push({ resolve, reject });
		return promise;
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(json: string): Uint8Array {
	return encoder.encode(`${json}\0`);
}

function concatenate(...chunks: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function observeClose(transport: ConnectOverCDPTransport): {
	closed: Promise<string | undefined>;
	observation: { calls: number; reason?: string };
} {
	const observation: { calls: number; reason?: string } = { calls: 0 };
	const { promise: closed, resolve } = Promise.withResolvers<string | undefined>();
	transport.onclose = reason => {
		observation.calls++;
		observation.reason = reason;
		resolve(reason);
	};
	return { closed, observation };
}

const compileTransportOverload: (transport: ConnectOverCDPTransport) => Promise<Browser> = transport =>
	chromium.connectOverCDP(transport, { isLocal: true, noDefaults: true });

describe("Playwright remote-debugging-pipe transport", () => {
	test("compile-contracts the pinned object transport overload without connecting", () => {
		expect(typeof compileTransportOverload).toBe("function");
		const pipe = new FakeBrowserPipe();
		const transport: ConnectOverCDPTransport = createPlaywrightPipeTransport(pipe);
		transport.close();
		expect(pipe.closeCalls).toBe(1);
	});

	test("fails closed before invoking an unmarked blocking native read", () => {
		let readCalls = 0;
		const blocking = {
			read(): Uint8Array {
				readCalls++;
				return new Uint8Array();
			},
			write() {},
			close() {},
		};
		expect(() => createPlaywrightPipeTransport(blocking as unknown as NativeBrowserPipeLike)).toThrow(
			"requires a nonblocking native pipe",
		);
		expect(readCalls).toBe(0);
	});

	test("incrementally parses split UTF-8 and coalesced object/array frames", async () => {
		const pipe = new FakeBrowserPipe();
		const transport = createPlaywrightPipeTransport(pipe);
		const first = { id: 1, result: { text: "before🙂after" } };
		const second = { method: "Runtime.event", params: { ready: true } };
		const third = [{ id: 3 }];
		const firstFrame = frame(JSON.stringify(first));
		const emojiStart = firstFrame.indexOf(0xf0);
		const messages: object[] = [];
		const { promise: received, resolve } = Promise.withResolvers<void>();
		transport.onmessage = message => {
			messages.push(message);
			if (messages.length === 3) resolve();
		};
		pipe.push(firstFrame.subarray(0, emojiStart + 2));
		pipe.push(
			concatenate(firstFrame.subarray(emojiStart + 2), frame(JSON.stringify(second)), frame(JSON.stringify(third))),
		);

		await received;
		expect(messages).toEqual([first, second, third]);
		transport.close();
		expect(pipe.closeCalls).toBe(1);
	});

	test("rejects malformed UTF-8, JSON, primitive shapes, and embedded framing", async () => {
		const fixtures = [
			frame('{"id":}'),
			frame("null"),
			new Uint8Array([0]),
			new Uint8Array([0x7b, 0x80, 0x7d, 0]),
			encoder.encode('{"id":1\0}\0'),
		];

		for (const bytes of fixtures) {
			const pipe = new FakeBrowserPipe();
			const transport = createPlaywrightPipeTransport(pipe);
			const { closed, observation } = observeClose(transport);
			pipe.push(bytes);
			expect(await closed).toBe("cdp-invalid-message");
			transport.close();
			transport.close();
			expect(pipe.closeCalls).toBe(1);
			expect(observation.calls).toBe(1);
		}
	});

	test("closes on oversized input before retaining it", async () => {
		const pipe = new FakeBrowserPipe();
		const transport = createPlaywrightPipeTransport(pipe);
		const { closed, observation } = observeClose(transport);
		const oversized = new Uint8Array(PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES + 1);
		oversized.fill(0x61);

		pipe.push(oversized);

		expect(await closed).toBe("cdp-message-too-large");
		expect(pipe.closeCalls).toBe(1);
		expect(observation.calls).toBe(1);
	});

	test("rejects an incomplete message at remote EOF", async () => {
		const pipe = new FakeBrowserPipe();
		const transport = createPlaywrightPipeTransport(pipe);
		const { closed } = observeClose(transport);
		pipe.push(encoder.encode('{"id":1}'));
		pipe.end();

		expect(await closed).toBe("cdp-invalid-message");
		expect(pipe.closeCalls).toBe(1);
	});

	test("serializes outbound messages in order with one terminal NUL", async () => {
		const pipe = new FakeBrowserPipe();
		const transport = createPlaywrightPipeTransport(pipe);
		const first = { id: 7, method: "Runtime.call", params: { text: "a\0🙂b" } };
		const second = [{ id: 8, method: "Runtime.release" }];
		const third = { id: 9, method: "Browser.getVersion", params: undefined };

		transport.send(first);
		transport.send(second);
		transport.send(third);
		await pipe.waitForWrites(3);

		expect(pipe.writes).toHaveLength(3);
		expect(decoder.decode(pipe.writes[0])).toBe(`${JSON.stringify(first)}\0`);
		expect(decoder.decode(pipe.writes[1])).toBe(`${JSON.stringify(second)}\0`);
		expect(decoder.decode(pipe.writes[2])).toBe(`${JSON.stringify(third)}\0`);
		for (const bytes of pipe.writes) {
			expect(bytes.at(-1)).toBe(0);
			expect(bytes.subarray(0, -1)).not.toContain(0);
		}
		transport.close();
	});

	test("bounds outbound serialization and closes fail-closed", () => {
		const pipe = new FakeBrowserPipe();
		const transport = createPlaywrightPipeTransport(pipe);
		const { observation } = observeClose(transport);
		const message = { value: "x".repeat(PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES) };

		expect(() => transport.send(message)).toThrow("CDP transport rejected an outbound message");
		expect(pipe.writeAttempts).toBe(0);
		expect(pipe.closeCalls).toBe(1);
		expect(observation).toEqual({ calls: 1, reason: "cdp-invalid-message" });
	});

	test("preflights deep graphs and never invokes custom JSON hooks", () => {
		const deepPipe = new FakeBrowserPipe();
		const deepTransport = createPlaywrightPipeTransport(deepPipe);
		const root: { next?: unknown } = {};
		let cursor = root;
		for (let depth = 0; depth < 65; depth++) {
			const next: { next?: unknown } = {};
			cursor.next = next;
			cursor = next;
		}

		expect(() => deepTransport.send(root)).toThrow("CDP transport rejected an outbound message");
		expect(deepPipe.writeAttempts).toBe(0);
		expect(deepPipe.closeCalls).toBe(1);

		const hookPipe = new FakeBrowserPipe();
		const hookTransport = createPlaywrightPipeTransport(hookPipe);
		let hookCalls = 0;
		const hooked = {};
		Object.defineProperty(hooked, "toJSON", {
			value: () => {
				hookCalls++;
				return {};
			},
		});

		expect(() => hookTransport.send(hooked)).toThrow("CDP transport rejected an outbound message");
		expect(hookCalls).toBe(0);
		expect(hookPipe.writeAttempts).toBe(0);
		expect(hookPipe.closeCalls).toBe(1);
	});

	test("propagates write failure as a bounded close reason", async () => {
		const pipe = new FakeBrowserPipe();
		pipe.writeFailure = new Error("WRITE_SECRET_CANARY");
		const transport = createPlaywrightPipeTransport(pipe);
		const { closed, observation } = observeClose(transport);

		transport.send({ id: 1, method: "Browser.getVersion" });

		expect(await closed).toBe("cdp-write-error");
		expect(pipe.writeAttempts).toBe(1);
		expect(pipe.closeCalls).toBe(1);
		expect(JSON.stringify(observation)).not.toContain("WRITE_SECRET_CANARY");
	});

	test("propagates read failure without exposing exception text", async () => {
		const pipe = new FakeBrowserPipe();
		const transport = createPlaywrightPipeTransport(pipe);
		const { closed, observation } = observeClose(transport);

		pipe.fail(new Error("READ_SECRET_CANARY"));

		expect(await closed).toBe("cdp-read-error");
		expect(pipe.closeCalls).toBe(1);
		expect(JSON.stringify(observation)).not.toContain("READ_SECRET_CANARY");
	});

	test("maps clean remote EOF and local teardown to one close", async () => {
		const remotePipe = new FakeBrowserPipe();
		const remoteTransport = createPlaywrightPipeTransport(remotePipe);
		const remote = observeClose(remoteTransport);
		remotePipe.end();

		expect(await remote.closed).toBe("cdp-remote-eof");
		remoteTransport.close();
		remoteTransport.close();
		expect(remotePipe.closeCalls).toBe(1);
		expect(remote.observation.calls).toBe(1);

		const localPipe = new FakeBrowserPipe();
		const localTransport = createPlaywrightPipeTransport(localPipe);
		const local = observeClose(localTransport);
		localTransport.close();
		localTransport.close();
		expect(await local.closed).toBe("cdp-local-close");
		expect(localPipe.closeCalls).toBe(1);
		expect(local.observation.calls).toBe(1);
	});
});
