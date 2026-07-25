import { Http2SessionManager } from "@connectrpc/connect-node";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../../utils/proxy";
import { isCursorTransportDisposed, setCursorTransportDisposer } from "./transport-lifecycle";

/**
 * Process-global HTTP/2 connection pool for Cursor agent traffic.
 *
 * Keyed by normalized origin plus proxy URL. Each key owns four round-robin
 * slots. Slots cycle through Vacant → Initializing → Healthy → (retired to
 * Vacant). Unhealthy managers are detached into a pool-level
 * `retiringManagers` set and closed at zero refs, allowing replacement without
 * losing disposal ownership.
 *
 * All timers and sockets are unrefed. Disposal is registered once with
 * postmortem via {@link setCursorTransportDisposer}.
 */

const POOL_SIZE = 4;
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 20_000;
const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

type HealthySlot = { kind: "healthy"; generation: number; manager: Http2SessionManager; leases: number };
type SlotState =
	| { readonly kind: "vacant" }
	| {
			readonly kind: "initializing";
			readonly generation: number;
			readonly promise: Promise<LeasedManager>;
			/** Cancels the in-progress proxy tunnel so disposal never waits it out. */
			readonly abort: AbortController;
	  }
	| HealthySlot;

interface LeasedManager {
	readonly manager: Http2SessionManager;
	readonly generation: number;
}

interface PoolEntry {
	slots: SlotState[];
	roundRobin: number;
}

interface RetiringManager {
	readonly manager: Http2SessionManager;
	leases: number;
}

const pools = new Map<string, PoolEntry>();
const retiringManagers = new Set<RetiringManager>();
let disposed = false;

function poolKey(origin: string, proxyUrl: string | undefined): string {
	return `${origin}|${proxyUrl ?? ""}`;
}

function normalizeOrigin(baseUrl: string): string {
	const url = new URL(baseUrl);
	return `${url.protocol}//${url.host}`;
}

/**
 * A leased H2 session manager. Call {@link H2Lease.release} when done with
 * the stream. The release decrements the lease counter and, if the manager
 * was retired, may trigger its closure at zero refs.
 */
export interface H2Lease {
	readonly manager: Http2SessionManager;
	release(): void;
}

class AbortError extends Error {
	override readonly name = "AbortError";
}

/**
 * Race an async promise against a caller's AbortSignal. If the signal fires
 * before the promise settles, reject with AbortError. The promise is NOT
 * cancelled — only the caller's wait is. The shared manager or another
 * waiter's acquisition continues unaffected.
 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AbortError("Aborted before wait"));
	const { promise: result, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = (): void => {
		signal.removeEventListener("abort", onAbort);
		reject(new AbortError("Aborted during wait"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return result;
}

/**
 * Acquire a healthy H2 session manager from the pool.
 *
 * Cold callers sharing a slot share initialization. Caller abort removes only
 * that waiter's promise and closes only its eventual stream; it never aborts
 * a shared manager. Unhealthy managers are retired and replaced.
 */
export async function acquireH2Session(baseUrl: string, provider: string, signal?: AbortSignal): Promise<H2Lease> {
	if (disposed || isCursorTransportDisposed()) {
		throw new Error("Cursor H2 pool has been disposed");
	}
	if (signal?.aborted) {
		throw new AbortError("Acquisition aborted before start");
	}

	const origin = normalizeOrigin(baseUrl);
	const proxyUrl = shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(provider);
	const key = poolKey(origin, proxyUrl);

	let entry = pools.get(key);
	if (!entry) {
		entry = {
			slots: Array.from({ length: POOL_SIZE }, () => ({ kind: "vacant" }) as SlotState),
			roundRobin: 0,
		};
		pools.set(key, entry);
	}

	// Try each of the POOL_SIZE slots, advancing the round-robin index.
	// The first real (non-Abort) setup error is remembered so that, if every
	// slot ultimately fails, the caller sees the most informative original
	// error instead of a generic aggregate. this path converts each slot's
	// real error into null only temporarily, while we keep trying.
	let lastSetupError: unknown = null;
	for (let attempts = 0; attempts < POOL_SIZE; attempts++) {
		const slotIndex = (entry.roundRobin + attempts) % POOL_SIZE;
		const slot = entry.slots[slotIndex];
		try {
			const result = await tryAcquireFromSlot(entry, slotIndex, slot, baseUrl, origin, proxyUrl, signal, key);
			if (result !== null) {
				// Advance the round-robin past this slot for next time.
				entry.roundRobin = (slotIndex + 1) % POOL_SIZE;
				return result;
			}
			// Slot was unhealthy/vacant/failed — try the next slot.
		} catch (error) {
			if (error instanceof AbortError) {
				throw error;
			}
			// Remember the most informative setup failure for the final throw.
			lastSetupError = error;
			// Slot has been reset; try the next slot.
		}
	}

	if (lastSetupError !== null) {
		throw lastSetupError;
	}
	throw new Error("Failed to acquire H2 session from all pool slots");
}

async function tryAcquireFromSlot(
	entry: PoolEntry,
	slotIndex: number,
	slot: SlotState,
	baseUrl: string,
	origin: string,
	proxyUrl: string | undefined,
	signal: AbortSignal | undefined,
	key: string,
): Promise<H2Lease | null> {
	if (slot.kind === "vacant") {
		// Cold acquisition: initialize the slot.
		const generation = Date.now() + slotIndex;
		const abort = new AbortController();
		const promise = createSessionManager(baseUrl, origin, proxyUrl, abort.signal).then(
			(manager): LeasedManager => {
				if (disposed) {
					manager.abort();
					throw new Error("Cursor H2 pool disposed during initialization");
				}
				const current: SlotState = entry.slots.at(slotIndex) ?? { kind: "vacant" };
				if (current.kind === "initializing" && current.generation === generation) {
					entry.slots[slotIndex] = { kind: "healthy", generation, manager, leases: 0 };
				} else {
					const retiring: RetiringManager = { manager, leases: 0 };
					retiringManagers.add(retiring);
					if (retiring.leases === 0) {
						retiringManagers.delete(retiring);
						manager.abort();
					}
				}
				return { manager, generation };
			},
			(error: unknown) => {
				const current: SlotState = entry.slots.at(slotIndex) ?? { kind: "vacant" };
				if (current.kind === "initializing" && current.generation === generation) {
					entry.slots[slotIndex] = { kind: "vacant" };
				}
				throw error;
			},
		);

		entry.slots[slotIndex] = { kind: "initializing", generation, promise, abort };

		try {
			await raceWithSignal(promise, signal);
			// Lease the now-healthy manager.
			const current: SlotState = entry.slots.at(slotIndex) ?? { kind: "vacant" };
			if (current.kind === "healthy" && current.generation === generation) {
				current.leases++;
				return makeLease(key, slotIndex, current);
			}
			// Slot was replaced (e.g. disposed); try next.
			return null;
		} catch (error) {
			if (error instanceof AbortError) {
				throw error;
			}
			// Init failed; slot is now vacant. Re-throw so the caller can
			// preserve the original setup error while still trying other slots.
			throw error;
		}
	}

	if (slot.kind === "initializing") {
		// Shared initialization: wait for the existing promise, racing
		// against the caller's signal so abort only cancels this waiter.
		try {
			const { generation } = await raceWithSignal(slot.promise, signal);
			const current: SlotState = entry.slots.at(slotIndex) ?? { kind: "vacant" };
			if (current.kind === "healthy" && current.generation === generation) {
				current.leases++;
				return makeLease(key, slotIndex, current);
			}
			return null;
		} catch (error) {
			if (error instanceof AbortError) {
				throw error;
			}
			// Init failed; slot is now vacant. Re-throw so the caller can
			// preserve the original setup error while still trying other slots.
			throw error;
		}
	}

	// Healthy: check health and lease.
	const state = slot.manager.state();
	if (state === "error" || state === "closed") {
		retireManager(key, slotIndex, slot);
		return null;
	}

	if (signal?.aborted) {
		throw new AbortError("Acquisition aborted before lease");
	}

	slot.leases++;
	return makeLease(key, slotIndex, slot);
}

function makeLease(key: string, slotIndex: number, slot: HealthySlot): H2Lease {
	const leasedGeneration = slot.generation;
	const leasedManager = slot.manager;
	let released = false;
	return {
		manager: leasedManager,
		release(): void {
			if (released) return;
			released = true;
			const entry = pools.get(key);
			if (entry) {
				const current: SlotState = entry.slots.at(slotIndex) ?? { kind: "vacant" };
				if (current.kind === "healthy" && current.generation === leasedGeneration) {
					current.leases = Math.max(0, current.leases - 1);
					return;
				}
			}
			// Manager was retired or evicted; find in retiringManagers and decrement.
			for (const rm of retiringManagers) {
				if (rm.manager === leasedManager) {
					rm.leases = Math.max(0, rm.leases - 1);
					if (rm.leases === 0) {
						retiringManagers.delete(rm);
						rm.manager.abort();
					}
					break;
				}
			}
		},
	};
}

function retireManager(key: string, slotIndex: number, slot: HealthySlot): void {
	const entry = pools.get(key);
	if (!entry) return;
	const current: SlotState = entry.slots.at(slotIndex) ?? { kind: "vacant" };
	if (current.kind === "healthy" && current.generation === slot.generation) {
		const retiring: RetiringManager = { manager: current.manager, leases: current.leases };
		retiringManagers.add(retiring);
		entry.slots[slotIndex] = { kind: "vacant" };
		if (retiring.leases === 0) {
			retiringManagers.delete(retiring);
			retiring.manager.abort();
		}
	}
}

/**
 * Create a session manager, optionally through a CONNECT proxy tunnel.
 *
 * For proxy: pre-connect the TLS tunnel socket, then pass it as
 * `createConnection` to `Http2SessionManager` via `http2.connect` options.
 * The session manager calls `http2.connect(authority, options)` lazily, and
 * the pre-connected socket is returned synchronously by `createConnection`.
 */
async function createSessionManager(
	baseUrl: string,
	origin: string,
	proxyUrl: string | undefined,
	signal?: AbortSignal,
): Promise<Http2SessionManager> {
	if (proxyUrl) {
		const tlsSocket = await connectProxiedSocket(proxyUrl, baseUrl, {
			timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
			signal,
		});
		const manager = new Http2SessionManager(
			origin,
			{
				pingIntervalMs: PING_INTERVAL_MS,
				pingTimeoutMs: PING_TIMEOUT_MS,
				pingIdleConnection: true,
			},
			{
				createConnection: () => tlsSocket,
			},
		);
		return manager;
	}
	return new Http2SessionManager(origin, {
		pingIntervalMs: PING_INTERVAL_MS,
		pingTimeoutMs: PING_TIMEOUT_MS,
		pingIdleConnection: true,
	});
}

/**
 * Dispose all Cursor H2 transport resources: close all pooled sessions and
 * retiring managers. Registered once with postmortem.
 */
export async function disposeCursorH2Pool(): Promise<void> {
	disposed = true;

	const closePromises: Array<Promise<void>> = [];

	for (const [, entry] of pools) {
		for (const slot of entry.slots) {
			if (slot.kind === "healthy") {
				closePromises.push(closeManager(slot.manager));
			} else if (slot.kind === "initializing") {
				// Cancel the pending tunnel first: waiting out the 30s proxy
				// timeout would blow past postmortem's disposal deadline.
				slot.abort.abort(new Error("Cursor H2 pool disposed"));
				closePromises.push(slot.promise.then(lm => closeManager(lm.manager)).catch(() => {}));
			}
		}
	}
	pools.clear();

	for (const rm of retiringManagers) {
		closePromises.push(closeManager(rm.manager));
	}
	retiringManagers.clear();

	await Promise.all(closePromises);
}

function closeManager(manager: Http2SessionManager): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	try {
		manager.abort();
	} catch {
		// Ignore close errors during disposal.
	}
	resolve();
	return promise;
}

/** Test-only: reset pool state without full disposal. */
export function __resetH2Pool(): void {
	pools.clear();
	retiringManagers.clear();
	disposed = false;
}

/** Test-only: get pool stats. */
export function __getH2PoolStats(): { poolCount: number; retiringCount: number } {
	return { poolCount: pools.size, retiringCount: retiringManagers.size };
}

/**
 * Test-only: evict the single pool entry for a given origin (+ optional
 * provider for proxy resolution), closing its healthy/initializing managers.
 * Leaves every other pool entry untouched so concurrent test files using
 * different origins are unaffected. Named invariant: only the entry whose
 * key matches `normalizeOrigin(baseUrl)` + resolved proxy URL is removed.
 */
export function __evictH2PoolEntry(baseUrl: string, provider = "cursor"): void {
	const origin = normalizeOrigin(baseUrl);
	const proxyUrl = shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(provider);
	const key = poolKey(origin, proxyUrl);
	const entry = pools.get(key);
	if (!entry) return;
	for (let i = 0; i < entry.slots.length; i++) {
		const slot = entry.slots[i];
		if (slot.kind === "healthy") {
			if (slot.leases > 0) {
				const retiring: RetiringManager = { manager: slot.manager, leases: slot.leases };
				retiringManagers.add(retiring);
			} else {
				closeManager(slot.manager);
			}
			entry.slots[i] = { kind: "vacant" };
		} else if (slot.kind === "initializing") {
			slot.promise.then(lm => closeManager(lm.manager)).catch(() => {});
			entry.slots[i] = { kind: "vacant" };
		}
	}
	pools.delete(key);
}

/**
 * Test-only: get pool stats scoped to a single origin (+ optional provider).
 * Returns 0/0 when no entry exists for that key.
 */
export function __getH2PoolStatsForOrigin(
	baseUrl: string,
	provider = "cursor",
): {
	poolCount: number;
	retiringCount: number;
} {
	const origin = normalizeOrigin(baseUrl);
	const proxyUrl = shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(provider);
	const key = poolKey(origin, proxyUrl);
	return pools.has(key) ? { poolCount: 1, retiringCount: retiringManagers.size } : { poolCount: 0, retiringCount: 0 };
}

// Register the disposer on module load.
setCursorTransportDisposer(disposeCursorH2Pool);
