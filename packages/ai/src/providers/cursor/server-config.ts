import {
	GetServerConfigRequestSchema,
	GetServerConfigResponseSchema,
	Http2Config,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { type ConnectFrame, ConnectFrameDecoder, encodeConnectFrame } from "./connect-frame";
import { acquireCursorH2, type CursorH2Lease } from "./h2-pool";
import { buildCursorUnaryHeaders } from "./headers";

/**
 * Account-scoped transport policy for the Cursor provider, fetched from the
 * server's `GetServerConfig` unary RPC. This is the ONLY input that may
 * authorize the HTTP/1.1 fallback bridge: a client may downgrade to HTTP/1.1
 * only when the server explicitly reports `FORCE_BIDI_DISABLED` or
 * `FORCE_ALL_DISABLED`. Everything else — a missing/unknown directive, a
 * failed fetch, a timeout, an abort, a non-2xx status, a frame-protocol error,
 * or a backend that does not expose this RPC — maps to `"unspecified"`, which
 * keeps HTTP/2. That is the invariant that stops a network hiccup from ever
 * downgrading a healthy account.
 */

export type CursorBidiAvailability = "unspecified" | "bidi-disabled" | "all-disabled";

/** Unary RPC path, matching the Cursor `AgentService.GetServerConfig` endpoint. */
const GET_SERVER_CONFIG_PATH = "/agent.v1.AgentService/GetServerConfig";

/** Wall-clock budget for one config fetch. Exceeding it fails open to `"unspecified"`. */
const CURSOR_SERVER_CONFIG_TIMEOUT_MS = 5_000;

/** Per-`apiKey`+`baseUrl` TTL; two calls within it make one wire request. */
const CURSOR_SERVER_CONFIG_TTL_MS = 30_000;

/** Maximum retained cache entries (LRU bound). */
const CURSOR_SERVER_CONFIG_CACHE_CAP = 8;

/** Cumulative decoded response cap; a config RPC is a few hundred bytes. */
const MAX_SERVER_CONFIG_RESPONSE_BYTES = 1_048_576; // 1 MiB

/**
 * Per-`apiKey`+`baseUrl` result cache. An `"unspecified"` result is cached
 * too — it is a valid answer, and the transport caller hits this fetch on
 * every ALPN failure, so a healthy account must not re-query on every retry.
 * The policy is per-ENDPOINT (the server's FORCE_* directives are scoped to
 * the backend, and `baseUrl` is independently configurable), so the key
 * composes both — same apiKey against endpoint A then B within the TTL must
 * not cross-contaminate. The map is bounded at `CURSOR_SERVER_CONFIG_CACHE_CAP`
 * entries (LRU) so a long-lived process with rotating keys does not hold
 * them forever; expired entries are pruned opportunistically on every write.
 */
const cache = new Map<string, { value: CursorBidiAvailability; expiresAt: number }>();

/** Removes entries whose TTL has elapsed. Called on every cache write. */
function pruneExpiredCache(): void {
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (entry.expiresAt <= now) cache.delete(key);
	}
}

/** Evicts least-recently-used entries until the cap is respected. */
function evictOverflowCache(): void {
	while (cache.size > CURSOR_SERVER_CONFIG_CACHE_CAP) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

/** Test seam: clears the cache so suites start from a cold store. */
export function resetCursorServerConfigCache(): void {
	cache.clear();
}

/** Test seam: current entry count, for LRU/pruning assertions. */
export function __cursorServerConfigCacheSize(): number {
	return cache.size;
}

/**
 * Returns the account's bidi availability, or `"unspecified"` when it cannot
 * be determined for any reason (fail open). The result is cached per
 * `apiKey`+`baseUrl` for the TTL; the cache is LRU-bounded and pruned on
 * every write.
 */
export async function fetchCursorBidiAvailability(args: {
	apiKey: string;
	baseUrl: string;
	signal?: AbortSignal;
}): Promise<CursorBidiAvailability> {
	const key = `${args.apiKey}|${args.baseUrl}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		// LRU: move to most-recently-used end.
		cache.delete(key);
		cache.set(key, cached);
		return cached.value;
	}
	const value = await fetchServerConfig(args.apiKey, args.baseUrl, args.signal);
	pruneExpiredCache();
	cache.set(key, { value, expiresAt: Date.now() + CURSOR_SERVER_CONFIG_TTL_MS });
	evictOverflowCache();
	return value;
}

async function fetchServerConfig(
	apiKey: string,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<CursorBidiAvailability> {
	const timeout = signal
		? AbortSignal.any([signal, AbortSignal.timeout(CURSOR_SERVER_CONFIG_TIMEOUT_MS)])
		: AbortSignal.timeout(CURSOR_SERVER_CONFIG_TIMEOUT_MS);
	try {
		const acquisition = await acquireCursorH2({
			baseUrl,
			requestPath: GET_SERVER_CONFIG_PATH,
			headers: buildCursorUnaryHeaders({ apiKey }),
			provider: "cursor",
			signal: timeout,
		});
		if (!acquisition.ok) return "unspecified";
		return await readServerConfigResponse(acquisition.lease);
	} catch {
		// Acquisition rejection, timeout, or abort: fail open.
		return "unspecified";
	}
}

/**
 * Drives one `GetServerConfig` response over the leased stream. The response is
 * a single data envelope (the serialized `GetServerConfigResponse`) followed by
 * an end-of-stream envelope. Every failure path — non-2xx status, frame
 * protocol error, an aborted/destroyed stream, a missing end-of-stream, or an
 * unparseable body — yields `"unspecified"`. Exported as a test seam so a
 * suite can hand the reader a lease whose stream was already closed when the
 * reader began — the deterministic way to exercise the closed-at-entry branch.
 */
export async function readServerConfigResponse(lease: CursorH2Lease): Promise<CursorBidiAvailability> {
	const { request, release } = lease;
	// An abort that fired during acquisition (before this function ran) already
	// destroyed the stream through the lease's own abort listener; its terminal
	// events were not observable here, so fail open immediately.
	if (request.closed || request.destroyed) {
		// The stream died between acquisition and handler installation. The
		// lease is still outstanding (no abort to auto-release it) — release it
		// here or the pool's draining entry leaks forever. `release` is
		// idempotent (h2-pool's `releaseLease`), so a concurrent abort that
		// already released is a no-op.
		lease.release();
		return "unspecified";
	}
	const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
	const chunks: Uint8Array[] = [];
	let cumulativeBytes = 0;
	const { promise, resolve } = Promise.withResolvers<CursorBidiAvailability>();
	let settled = false;
	const finish = (value: CursorBidiAvailability): void => {
		if (settled) return;
		settled = true;
		release();
		resolve(value);
	};

	request.on("response", headers => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status > 299) finish("unspecified");
	});
	request.on("data", chunk => {
		let frames: ConnectFrame[];
		try {
			frames = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		} catch {
			finish("unspecified");
			return;
		}
		for (const frame of frames) {
			if (frame.kind === "data") {
				cumulativeBytes += frame.payload.length;
				if (cumulativeBytes > MAX_SERVER_CONFIG_RESPONSE_BYTES) {
					// Cumulative response cap: a config RPC is a few hundred bytes;
					// > 1 MiB of decoded data frames is a misbehaving or hostile
					// backend. Stop consuming (destroy the stream) and fail open
					// through the same `finish` path as every other failure mode.
					request.destroy();
					finish("unspecified");
					return;
				}
				chunks.push(frame.payload);
			} else if (frame.error) {
				// End-of-stream carrying a Connect error (e.g. unimplemented):
				// the backend may not expose this RPC on this generation. Fail open.
				finish("unspecified");
				return;
			} else {
				finish(decodeServerConfig(chunks));
				return;
			}
		}
	});
	request.on("error", () => finish("unspecified"));
	request.on("close", () => {
		// Always fires once the stream is done. "data" already settled on a
		// clean end-of-stream envelope; otherwise require that the envelope was
		// seen and decode what arrived. A destroyed or aborted stream never
		// reaches a clean envelope, so `decoder.finish()` throws and it fails
		// open.
		try {
			decoder.finish();
		} catch {
			finish("unspecified");
			return;
		}
		finish(decodeServerConfig(chunks));
	});

	try {
		request.write(
			encodeConnectFrame(toBinary(GetServerConfigRequestSchema, create(GetServerConfigRequestSchema, {})), false),
		);
		request.end();
	} catch {
		// A synchronous write/end failure (the stream closed between the
		// handler-install above and the write) would otherwise unwind past
		// `return promise` and skip `finish` — the same lease-leak shape as the
		// closed-at-entry branch. Settle through `finish` so the lease is
		// released and the failure fails open.
		finish("unspecified");
	}

	return promise;
}

function decodeServerConfig(chunks: Uint8Array[]): CursorBidiAvailability {
	try {
		const message = fromBinary(GetServerConfigResponseSchema, concatBytes(chunks));
		return mapHttp2Config(message.http2Config);
	} catch {
		return "unspecified";
	}
}

function mapHttp2Config(value: number | undefined): CursorBidiAvailability {
	switch (value) {
		case Http2Config.FORCE_BIDI_DISABLED:
			return "bidi-disabled";
		case Http2Config.FORCE_ALL_DISABLED:
			return "all-disabled";
		default:
			return "unspecified";
	}
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
