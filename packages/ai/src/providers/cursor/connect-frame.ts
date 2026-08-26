import * as AIError from "../../error";

/**
 * Connect v1 streaming envelope framing, per
 * <https://connectrpc.com/docs/protocol/>: `[1 byte flags][4 byte uint32
 * big-endian length][payload]`. This module is the single owner of that
 * grammar so the HTTP/2 path (cursor.ts today, the pooled transport later)
 * and the HTTP/1.1 poll bridge share one codec.
 *
 * Envelope flags: bit 0 (`0x01`) marks a gzip-compressed payload, bit 1
 * (`0x02`) marks the end-of-stream envelope; bits 2-7 are reserved and any
 * receiver MUST reject an unknown flag as a protocol error. Compression is
 * per-envelope and stateless across frames, so each envelope is compressed
 * and decompressed independently.
 */

export const CONNECT_FLAG_COMPRESSED = 0b00000001;
export const CONNECT_FLAG_END_STREAM = 0b00000010;
export const CONNECT_FLAG_RESERVED_MASK = 0b11111100;

/**
 * Hard upper bound on a single Connect frame payload. The 4-byte length prefix
 * is otherwise attacker-controlled (up to `2**32 - 1`), so a malicious or buggy
 * peer could force a reader to buffer gigabytes via `Buffer.concat` before an
 * idle-timeout wrapper aborts. Well above any legitimate response but tight
 * enough that a corrupt length prefix fails fast instead of consuming memory
 * (same convention as devin.ts:77).
 */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

/** A protocol-level violation of the Connect envelope grammar. */
export class ConnectProtocolError extends AIError.ProviderResponseError {}

export interface ConnectDataFrame {
	kind: "data";
	payload: Uint8Array;
}
export interface ConnectEndFrame {
	kind: "end";
	error: Error | null;
}
export type ConnectFrame = ConnectDataFrame | ConnectEndFrame;

/**
 * gRPC carries trailer messages percent-encoded; mirror that decode so the
 * surfaced error reads the server's real text. A malformed escape (e.g. a bare
 * `%` not forming a valid triple) falls back to the raw string rather than
 * letting a `URIError` escape out of the parser.
 */
function decodePercentEncoded(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Parses an end-of-stream envelope payload. Returns `null` on a clean end, or
 * a `ConnectProtocolError` naming the carried error. May throw
 * `ConnectProtocolError` on malformed JSON, a non-object payload, or a
 * non-object error entry; it never throws a raw error out of the parser.
 */
function parseEndStreamFrame(payload: Uint8Array): Error | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		throw new ConnectProtocolError("Connect end stream carried malformed JSON", {
			kind: "envelope",
		});
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConnectProtocolError("Connect end stream payload was not an object", {
			kind: "envelope",
		});
	}
	const error = "error" in parsed ? parsed.error : undefined;
	if (error === undefined || error === null) return null;
	if (typeof error !== "object" || Array.isArray(error)) {
		throw new ConnectProtocolError("Connect end stream error entry was not an object", {
			kind: "envelope",
		});
	}
	const code = "code" in error && typeof error.code === "string" && error.code ? error.code : "unknown";
	const message =
		"message" in error && typeof error.message === "string" && error.message ? error.message : "Unknown error";
	return new ConnectProtocolError(`Connect error ${code}: ${decodePercentEncoded(message)}`, { kind: "envelope" });
}

/**
 * Encodes `payload` into a Connect envelope. When `compress` is set the body is
 * `gzip`-compressed and the envelope's bit-0 flag is set; the frame is always
 * `[flags][uint32BE length][payload]`.
 */
export function encodeConnectFrame(payload: Uint8Array, compress: boolean): Buffer {
	const body = compress ? Bun.gzipSync(payload as Uint8Array<ArrayBuffer>) : payload;
	let flags = 0;
	if (compress) flags |= CONNECT_FLAG_COMPRESSED;
	const frame = Buffer.alloc(5 + body.length);
	frame[0] = flags;
	frame.writeUInt32BE(body.length, 1);
	frame.set(body, 5);
	return frame;
}

/**
 * Stateful per-stream Connect decoder. Appends raw bytes and emits every frame
 * that completes, enforcing the terminal grammar: reserved flags and unknown
 * compression are rejected, at most one end-of-stream envelope may arrive, and
 * `finish()` requires that the end-of-stream envelope was seen.
 */
export class ConnectFrameDecoder {
	readonly #acceptCompressed: boolean;
	#buffer: Buffer = Buffer.alloc(0);
	#sawEndStream = false;

	constructor(options: { acceptCompressed: boolean }) {
		this.#acceptCompressed = options.acceptCompressed;
	}

	get sawEndStream(): boolean {
		return this.#sawEndStream;
	}

	/** Appends bytes and returns every frame that completed. Throws `ConnectProtocolError`. */
	push(chunk: Buffer): ConnectFrame[] {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

		const frames: ConnectFrame[] = [];
		while (this.#buffer.length >= 5) {
			const flags = this.#buffer[0];
			const msgLen = this.#buffer.readUInt32BE(1);
			// Reject a declared length above the cap before treating the frame as
			// present — the 4-byte prefix is otherwise attacker-controlled.
			if (msgLen > MAX_CONNECT_FRAME_PAYLOAD) {
				throw new ConnectProtocolError(
					`Cursor Connect frame length ${msgLen} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
					{ kind: "envelope" },
				);
			}
			if (this.#buffer.length < 5 + msgLen) break;

			const payload = this.#buffer.subarray(5, 5 + msgLen);
			this.#buffer = this.#buffer.subarray(5 + msgLen);

			// No frame may follow the end-of-stream envelope.
			if (this.#sawEndStream) {
				throw new ConnectProtocolError("Cursor Connect received a frame after end-of-stream", {
					kind: "envelope",
				});
			}

			if ((flags & CONNECT_FLAG_RESERVED_MASK) !== 0) {
				throw new ConnectProtocolError(`Cursor Connect protocol error: invalid envelope flags ${flags}`, {
					kind: "envelope",
				});
			}

			let body: Uint8Array = payload;
			if ((flags & CONNECT_FLAG_COMPRESSED) !== 0) {
				if (!this.#acceptCompressed) {
					throw new ConnectProtocolError(
						"Cursor Connect received a compressed envelope but compression was not negotiated",
						{ kind: "envelope" },
					);
				}
				try {
					body = Bun.gunzipSync(payload as Uint8Array<ArrayBuffer>);
				} catch (e) {
					throw new ConnectProtocolError("Cursor Connect envelope declared gzip but could not be decompressed", {
						kind: "envelope",
						cause: e,
					});
				}
			}

			if ((flags & CONNECT_FLAG_END_STREAM) !== 0) {
				this.#sawEndStream = true;
				frames.push({ kind: "end", error: parseEndStreamFrame(body) });
			} else {
				frames.push({ kind: "data", payload: body });
			}
		}
		return frames;
	}

	/** Call on stream EOF. Throws `ConnectProtocolError` when no end-of-stream was seen. */
	finish(): void {
		if (!this.#sawEndStream) {
			throw new ConnectProtocolError("Cursor stream ended before end-of-stream frame", {
				kind: "incomplete-stream",
			});
		}
	}
}
