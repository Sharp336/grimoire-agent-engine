import type * as http2 from "node:http2";
import { Http2SessionManager } from "@connectrpc/connect-node";
import { postmortem } from "@oh-my-pi/pi-utils";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";

/**
 * Process-global pool of HTTP/2 sessions for the Cursor Run RPC. Each pool key
 * ({@link poolKey}) owns a fixed set of round-robin {@link Http2SessionManager}
 * slots. The manager keeps each connection alive with PING frames and unrefs the
 * socket/timers while idle, so a warm pool never blocks process exit; an active
 * request stream re-refs the socket for its lifetime. A logical turn releases
 * only its own stream — the shared session survives for the next turn.
 */

const CURSOR_H2_SLOTS_PER_KEY = 4;
/** Idle keepalive PING cadence. */
const CURSOR_H2_PING_INTERVAL_MS = 10_000;
/** A PING unanswered within this window marks the session unhealthy. */
const CURSOR_H2_PING_TIMEOUT_MS = 20_000;
const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

interface PoolSlot {
	manager: Http2SessionManager;
}

interface PoolEntry {
	slots: (PoolSlot | null)[];
	rr: number;
}

const pool = new Map<string, PoolEntry>();

/** Pool key contains only the normalized H2 origin and proxy URL — never any credential. */
function poolKey(origin: string, proxyUrl: string | undefined): string {
	return `${origin}\u0000${proxyUrl ?? ""}`;
}

const PING_OPTIONS = {
	pingIntervalMs: CURSOR_H2_PING_INTERVAL_MS,
	pingTimeoutMs: CURSOR_H2_PING_TIMEOUT_MS,
	pingIdleConnection: true,
} as const;

async function createManager(
	baseUrl: string,
	proxyUrl: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Http2SessionManager> {
	if (!proxyUrl) {
		return new Http2SessionManager(baseUrl, PING_OPTIONS);
	}
	// CONNECT-proxy: establish the tunnel (ALPN h2) up front and hand the ready
	// socket to the session. If this connection later dies, the manager reports an
	// error/closed state and the pool evicts the slot, re-tunneling on next use.
	const tunnel = await connectProxiedSocket(proxyUrl, baseUrl, {
		signal,
		timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
	});
	return new Http2SessionManager(baseUrl, PING_OPTIONS, {
		createConnection: () => tunnel,
	});
}

/** Resolve the effective proxy for the Cursor provider, honoring NO_PROXY/local bypass. */
export function resolveCursorProxy(baseUrl: string, provider: string): string | undefined {
	return shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(provider);
}

export interface AcquireCursorStreamParams {
	baseUrl: string;
	provider: string;
	requestPath: string;
	/** Non-pseudo request headers; `:method`/`:path` are supplied separately. */
	headers: http2.OutgoingHttpHeaders;
	signal?: AbortSignal;
}

/**
 * Acquire a Run request stream from a pooled, health-checked HTTP/2 session.
 * Evicts and replaces a slot whose session has entered an error/closed state.
 */
export async function acquireCursorStream(params: AcquireCursorStreamParams): Promise<http2.ClientHttp2Stream> {
	const proxyUrl = resolveCursorProxy(params.baseUrl, params.provider);
	const origin = new URL(params.baseUrl).origin;
	const key = poolKey(origin, proxyUrl);

	let entry = pool.get(key);
	if (!entry) {
		entry = { slots: new Array<PoolSlot | null>(CURSOR_H2_SLOTS_PER_KEY).fill(null), rr: 0 };
		pool.set(key, entry);
	}

	const idx = entry.rr;
	entry.rr = (entry.rr + 1) % CURSOR_H2_SLOTS_PER_KEY;

	let slot = entry.slots[idx];
	if (slot) {
		const state = slot.manager.state();
		if (state === "error" || state === "closed") {
			slot.manager.abort();
			slot = null;
			entry.slots[idx] = null;
		}
	}
	if (!slot) {
		slot = { manager: await createManager(params.baseUrl, proxyUrl, params.signal) };
		entry.slots[idx] = slot;
	}

	try {
		return await slot.manager.request("POST", params.requestPath, params.headers, {});
	} catch (error) {
		// A failed acquisition means the session is unusable — evict it so the next
		// turn re-establishes rather than reusing a broken slot.
		slot.manager.abort();
		if (entry.slots[idx] === slot) {
			entry.slots[idx] = null;
		}
		throw error;
	}
}

/** Close every pooled session and clear the pool. Idempotent; safe to call from tests and teardown. */
export function disposeCursorTransport(): void {
	for (const entry of pool.values()) {
		for (let i = 0; i < entry.slots.length; i++) {
			entry.slots[i]?.manager.abort();
			entry.slots[i] = null;
		}
	}
	pool.clear();
}

postmortem.register("cursor-h2-pool", disposeCursorTransport);
