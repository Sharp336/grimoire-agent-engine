import type { ConnectOverCDPTransport } from "playwright-core";

/** Structural subset of the private native browser pipe consumed by this adapter. */
export interface NativeBrowserPipeLike {
	/** Set only by a package-owned adapter backed by a genuinely asynchronous/native nonblocking read. */
	readonly nonBlocking: true;
	read(): AsyncIterable<Uint8Array> | Promise<Uint8Array>;
	write(bytes: Uint8Array): Promise<void> | void;
	close(): Promise<void> | void;
}

const PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES + 1;
const BUFFER_BLOCK_BYTES = 64 * 1024;

const CLOSE_REASON = {
	bufferOverflow: "cdp-buffer-overflow",
	handlerError: "cdp-handler-error",
	invalidMessage: "cdp-invalid-message",
	localClose: "cdp-local-close",
	messageTooLarge: "cdp-message-too-large",
	readError: "cdp-read-error",
	remoteEof: "cdp-remote-eof",
	writeError: "cdp-write-error",
} as const;

type CloseReason = (typeof CLOSE_REASON)[keyof typeof CLOSE_REASON];

function isProtocolMessage(value: unknown): value is object {
	return value !== null && typeof value === "object";
}

function boundedUtf8Length(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
		if (bytes > PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES) return bytes;
	}
	return bytes;
}

function assertBoundedProtocolGraph(root: object): void {
	const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: root }];
	const seen = new WeakSet<object>();
	let valueCount = 0;
	let stringBytes = 0;

	while (stack.length > 0) {
		const entry = stack.pop();
		if (!entry) break;
		const { depth, value } = entry;
		if (++valueCount > 100_000 || depth > 64) {
			throw new Error("CDP transport rejected an outbound message");
		}
		if (typeof value === "string") {
			stringBytes += boundedUtf8Length(value);
			if (!Number.isSafeInteger(stringBytes) || stringBytes > PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES) {
				throw new Error("CDP transport rejected an outbound message");
			}
			continue;
		}
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			continue;
		}
		if (typeof value !== "object") throw new Error("CDP transport rejected an outbound message");

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
			throw new Error("CDP transport rejected an outbound message");
		}
		if (seen.has(value)) throw new Error("CDP transport rejected an outbound message");
		seen.add(value);
		if (Object.hasOwn(value, "toJSON")) {
			throw new Error("CDP transport rejected an outbound message");
		}

		if (Array.isArray(value)) {
			if (value.length > 100_000 - valueCount - stack.length) {
				throw new Error("CDP transport rejected an outbound message");
			}
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (descriptor && !("value" in descriptor)) {
					throw new Error("CDP transport rejected an outbound message");
				}
				const item = descriptor?.value;
				stack.push({
					depth: depth + 1,
					value: item === undefined || typeof item === "function" || typeof item === "symbol" ? null : item,
				});
			}
			continue;
		}

		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) {
				throw new Error("CDP transport rejected an outbound message");
			}
			if (descriptor.value === undefined) continue;
			stringBytes += boundedUtf8Length(key);
			if (!Number.isSafeInteger(stringBytes) || stringBytes > PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES) {
				throw new Error("CDP transport rejected an outbound message");
			}
			if (stack.length >= 100_000 - valueCount) {
				throw new Error("CDP transport rejected an outbound message");
			}
			stack.push({ depth: depth + 1, value: descriptor.value });
		}
	}
}

function serializeMessage(message: object): Uint8Array {
	if (!isProtocolMessage(message)) throw new Error("CDP transport rejected an outbound message");
	try {
		assertBoundedProtocolGraph(message);
	} catch {
		throw new Error("CDP transport rejected an outbound message");
	}

	let json: string | undefined;
	try {
		json = JSON.stringify(message);
	} catch {
		throw new Error("CDP transport rejected an outbound message");
	}
	if (json === undefined || (json[0] !== "{" && json[0] !== "[")) {
		throw new Error("CDP transport rejected an outbound message");
	}

	const byteLength = boundedUtf8Length(json);
	if (byteLength > PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES) {
		throw new Error("CDP transport rejected an oversized outbound message");
	}
	const frame = new Uint8Array(byteLength + 1);
	const encoded = new TextEncoder().encodeInto(json, frame.subarray(0, byteLength));
	if (encoded.read !== json.length || encoded.written !== byteLength) {
		throw new Error("CDP transport rejected an outbound message");
	}
	return frame;
}

/**
 * Adapts Chromium's private UTF-8 JSON/NUL byte pipe to Playwright's object transport.
 * The returned value deliberately exposes no endpoint, URL, path, or browser descriptor.
 */
export function createPlaywrightPipeTransport(pipe: NativeBrowserPipeLike): ConnectOverCDPTransport {
	let started = false;
	let closed = false;
	let closeNotified = false;
	let queuedWriteBytes = 0;
	if (pipe.nonBlocking !== true) {
		throw new Error("CDP transport requires a nonblocking native pipe");
	}
	let writeTail: Promise<void> = Promise.resolve();

	let frameBytes = 0;
	let blockOffset = 0;
	let blocks: Uint8Array[] = [];

	const transport: ConnectOverCDPTransport = {
		onmessage: undefined,
		onclose: undefined,
		open: start,
		send,
		close: () => terminate(CLOSE_REASON.localClose),
	};

	function notifyClose(reason: CloseReason): void {
		if (closeNotified) return;
		closeNotified = true;
		try {
			transport.onclose?.(reason);
		} catch {
			// Consumer callbacks cannot reopen the closed native capability.
		}
	}

	function terminate(reason: CloseReason): void {
		if (closed) return;
		closed = true;
		resetFrame();
		try {
			void Promise.resolve(pipe.close()).catch(() => undefined);
		} catch {
			// The categorical close reason is the only diagnostic crossing this boundary.
		}
		notifyClose(reason);
	}

	function resetFrame(): void {
		frameBytes = 0;
		blockOffset = 0;
		blocks = [];
	}

	function appendFrameBytes(bytes: Uint8Array): boolean {
		if (bytes.byteLength === 0) return true;
		const nextSize = frameBytes + bytes.byteLength;
		if (!Number.isSafeInteger(nextSize) || nextSize > MAX_BUFFERED_BYTES) {
			terminate(CLOSE_REASON.bufferOverflow);
			return false;
		}
		if (nextSize > PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES) {
			terminate(CLOSE_REASON.messageTooLarge);
			return false;
		}

		let sourceOffset = 0;
		while (sourceOffset < bytes.byteLength) {
			let block = blocks.at(-1);
			if (!block || blockOffset === block.byteLength) {
				block = new Uint8Array(Math.min(BUFFER_BLOCK_BYTES, PLAYWRIGHT_PIPE_MAX_MESSAGE_BYTES - frameBytes));
				blocks.push(block);
				blockOffset = 0;
			}
			const count = Math.min(block.byteLength - blockOffset, bytes.byteLength - sourceOffset);
			block.set(bytes.subarray(sourceOffset, sourceOffset + count), blockOffset);
			blockOffset += count;
			frameBytes += count;
			sourceOffset += count;
		}
		return true;
	}

	function decodeFrame(): string {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		if (blocks.length === 1) return decoder.decode(blocks[0].subarray(0, blockOffset));

		const decoded: string[] = [];
		for (let index = 0; index < blocks.length; index++) {
			const block = blocks[index];
			const used = index === blocks.length - 1 ? blockOffset : block.byteLength;
			decoded.push(decoder.decode(block.subarray(0, used), { stream: true }));
		}
		decoded.push(decoder.decode());
		return decoded.join("");
	}

	function dispatchFrame(): boolean {
		if (frameBytes === 0) {
			terminate(CLOSE_REASON.invalidMessage);
			return false;
		}

		let json: string;
		try {
			json = decodeFrame();
		} catch {
			terminate(CLOSE_REASON.invalidMessage);
			return false;
		}
		resetFrame();

		let message: unknown;
		try {
			message = JSON.parse(json);
		} catch {
			terminate(CLOSE_REASON.invalidMessage);
			return false;
		}
		if (!isProtocolMessage(message)) {
			terminate(CLOSE_REASON.invalidMessage);
			return false;
		}

		try {
			transport.onmessage?.(message);
		} catch {
			terminate(CLOSE_REASON.handlerError);
			return false;
		}
		return !closed;
	}

	async function* readChunks(): AsyncGenerator<Uint8Array> {
		const first = pipe.read();
		if (Symbol.asyncIterator in first) {
			for await (const chunk of first) yield chunk;
			return;
		}
		let chunk = await first;
		while (chunk.byteLength > 0) {
			yield chunk;
			const next = pipe.read();
			if (Symbol.asyncIterator in next) throw new Error("CDP pipe changed read mode");
			chunk = await next;
		}
	}

	async function readLoop(): Promise<void> {
		try {
			for await (const chunk of readChunks()) {
				if (closed) return;
				if (!(chunk instanceof Uint8Array)) {
					terminate(CLOSE_REASON.invalidMessage);
					return;
				}

				let segmentStart = 0;
				for (let index = 0; index < chunk.byteLength; index++) {
					if (chunk[index] !== 0) continue;
					if (!appendFrameBytes(chunk.subarray(segmentStart, index)) || !dispatchFrame()) return;
					segmentStart = index + 1;
				}
				if (!appendFrameBytes(chunk.subarray(segmentStart))) return;
			}
			if (frameBytes !== 0) terminate(CLOSE_REASON.invalidMessage);
			else terminate(CLOSE_REASON.remoteEof);
		} catch {
			terminate(CLOSE_REASON.readError);
		}
	}

	function start(): void {
		if (started || closed) return;
		started = true;
		void readLoop();
	}

	function send(message: object): void {
		if (closed) throw new Error("CDP transport is closed");

		let frame: Uint8Array;
		try {
			frame = serializeMessage(message);
		} catch {
			terminate(CLOSE_REASON.invalidMessage);
			throw new Error("CDP transport rejected an outbound message");
		}

		if (queuedWriteBytes + frame.byteLength > MAX_BUFFERED_BYTES) {
			terminate(CLOSE_REASON.bufferOverflow);
			throw new Error("CDP transport rejected buffered outbound messages");
		}
		queuedWriteBytes += frame.byteLength;
		writeTail = writeTail
			.then(async () => {
				if (!closed) await pipe.write(frame);
			})
			.catch(() => terminate(CLOSE_REASON.writeError))
			.finally(() => {
				queuedWriteBytes -= frame.byteLength;
			});
	}

	queueMicrotask(start);
	return transport;
}
