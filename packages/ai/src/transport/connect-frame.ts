import { gunzipSync } from "node:zlib";

export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;
const CONNECT_HEADER_BYTES = 5;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function encodeConnectFrame(payload: Uint8Array, flags = 0): Uint8Array {
	const frame = new Uint8Array(CONNECT_HEADER_BYTES + payload.byteLength);
	frame[0] = flags;
	new DataView(frame.buffer, frame.byteOffset, CONNECT_HEADER_BYTES).setUint32(1, payload.byteLength, false);
	frame.set(payload, CONNECT_HEADER_BYTES);
	return frame;
}

export interface ConnectFrame {
	flags: number;
	payload: Uint8Array;
	endOfStream: boolean;
}

export type ConnectTerminal =
	| { kind: "success" }
	| { kind: "provider-error"; code: string; message: string };

export function createConnectFrameReader(options?: { maxPayloadBytes?: number }): {
	push(chunk: Uint8Array): ConnectFrame[];
	finish(): void;
} {
	const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
	if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
		throw new RangeError("maxPayloadBytes must be a non-negative safe integer");
	}
	let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	let sawEndOfStream = false;

	return {
		push(chunk: Uint8Array): ConnectFrame[] {
			if (sawEndOfStream && chunk.byteLength > 0) {
				const duplicate = chunk.byteLength >= CONNECT_HEADER_BYTES && (chunk[0] & CONNECT_END_STREAM_FLAG) !== 0;
				throw new RangeError(
					duplicate
						? "Connect stream contains duplicate end-of-stream"
						: "Connect stream contains data after end-of-stream",
				);
			}
			if (chunk.byteLength > 0) {
				if (pending.byteLength === 0) {
					pending = chunk;
				} else {
					const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
					joined.set(pending);
					joined.set(chunk, pending.byteLength);
					pending = joined;
				}
			}

			const frames: ConnectFrame[] = [];
			let offset = 0;
			while (pending.byteLength - offset >= CONNECT_HEADER_BYTES) {
				const view = new DataView(pending.buffer, pending.byteOffset + offset, CONNECT_HEADER_BYTES);
				const flags = view.getUint8(0);
				if ((flags & ~(CONNECT_COMPRESSED_FLAG | CONNECT_END_STREAM_FLAG)) !== 0) {
					throw new RangeError(`Connect frame uses unknown flags 0x${flags.toString(16)}`);
				}
				if (sawEndOfStream) {
					throw new RangeError(
						(flags & CONNECT_END_STREAM_FLAG) !== 0
							? "Connect stream contains duplicate end-of-stream"
							: "Connect stream contains data after end-of-stream",
					);
				}
				const payloadLength = view.getUint32(1, false);
				if (payloadLength > maxPayloadBytes) {
					throw new RangeError(`Connect frame payload ${payloadLength} exceeds ${maxPayloadBytes} bytes`);
				}
				if (pending.byteLength - offset < CONNECT_HEADER_BYTES + payloadLength) break;

				const encoded = pending.subarray(
					offset + CONNECT_HEADER_BYTES,
					offset + CONNECT_HEADER_BYTES + payloadLength,
				);
				const payload =
					(flags & CONNECT_COMPRESSED_FLAG) !== 0
						? new Uint8Array(gunzipSync(encoded, { maxOutputLength: maxPayloadBytes }))
						: encoded;
				const endOfStream = (flags & CONNECT_END_STREAM_FLAG) !== 0;
				if (endOfStream) sawEndOfStream = true;
				frames.push({ flags, payload, endOfStream });
				offset += CONNECT_HEADER_BYTES + payloadLength;
			}

			if (offset === pending.byteLength) pending = new Uint8Array(0);
			else if (offset > 0) pending = pending.subarray(offset);
			return frames;
		},
		finish(): void {
			if (pending.byteLength > 0) {
				if (pending.byteLength < CONNECT_HEADER_BYTES) {
					throw new RangeError(
						`Connect stream ended with an incomplete frame header (${pending.byteLength} of ${CONNECT_HEADER_BYTES} bytes)`,
					);
				}
				const payloadLength = new DataView(pending.buffer, pending.byteOffset, CONNECT_HEADER_BYTES).getUint32(
					1,
					false,
				);
				throw new RangeError(
					`Connect stream ended with an incomplete frame payload (${pending.byteLength - CONNECT_HEADER_BYTES} of ${payloadLength} bytes)`,
				);
			}
			if (!sawEndOfStream) throw new RangeError("Connect stream ended without end-of-stream");
		},
	};
}

export function decodeConnectTerminal(payload: Uint8Array): ConnectTerminal {
	if (payload.byteLength === 0) return { kind: "success" };
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(payload));
	} catch (error) {
		throw new RangeError("Connect end-of-stream payload is malformed JSON", { cause: error });
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RangeError("Connect end-of-stream payload must be an object");
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "error" && key !== "metadata") {
			throw new RangeError(`Connect end-of-stream payload has unknown field ${key}`);
		}
	}
	if (!("error" in record) || record.error === null || record.error === undefined) return { kind: "success" };
	if (!record.error || typeof record.error !== "object" || Array.isArray(record.error)) {
		throw new RangeError("Connect end-of-stream error must be an object");
	}
	const error = record.error as Record<string, unknown>;
	const code = error.code;
	const message = error.message;
	if (typeof code !== "string" || typeof message !== "string" || (!code && !message)) {
		throw new RangeError("Connect end-of-stream error requires string code and message");
	}
	return { kind: "provider-error", code, message };
}

export function readConnectTrailerError(payload: Uint8Array): { code: string; message: string } | null {
	const terminal = decodeConnectTerminal(payload);
	return terminal.kind === "provider-error" ? { code: terminal.code, message: terminal.message } : null;
}
