import type { ClientHttp2Stream } from "node:http2";
import { constants as http2Constants } from "node:http2";
import { Http2SessionManager } from "@connectrpc/connect-node";
import * as AIError from "../error";
import { connectDirectSocket, connectProxiedSocket, getProxyForUrl } from "../utils/proxy";
import { isTransportDisposed, registerTransportDisposer } from "./lifecycle";

const POOL_SIZE = 4;
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 20_000;
const PROXY_TUNNEL_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 30_000;

type HealthySlot = { kind: "healthy"; generation: number; manager: Http2SessionManager; leases: number };
type InitializingSlot = {
	kind: "initializing";
	generation: number;
	promise: Promise<Http2SessionManager>;
	abort: AbortController;
	waiters: number;
};
type SlotState = { kind: "vacant" } | InitializingSlot | HealthySlot;

type Http2ConnectState = "open" | "idle" | "error";

export interface H2SessionOptions {
	signal?: AbortSignal;
	ca?: string | string[];
}

interface PoolEntry {
	key: string;
	slots: SlotState[];
	roundRobin: number;
}

interface RetiringManager {
	manager: Http2SessionManager;
	leases: number;
}

export interface H2Lease {
	request(headers: Record<string, string>, options?: { signal?: AbortSignal }): Promise<ClientHttp2Stream>;
	release(): void;
}

const pools = new Map<string, PoolEntry>();
const retiringManagers = new Set<RetiringManager>();
let nextGeneration = 1;
let poolDisposing = false;
let poolDisposalPromise: Promise<void> | undefined;

function waitWithSignal<T>(
	source: Promise<T>,
	signal: AbortSignal | undefined,
	onLateValue?: (value: T) => void,
): Promise<T> {
	if (!signal) return source;
	if (signal.aborted) return Promise.reject(new AIError.AbortError());
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const onAbort = (): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", onAbort);
		reject(new AIError.AbortError());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	source.then(
		value => {
			if (settled) {
				onLateValue?.(value);
				return;
			}
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return promise;
}

function closeManager(manager: Http2SessionManager, reason?: Error): void {
	try {
		manager.abort(reason);
	} catch {
		// Disposal is best-effort and must continue draining the other managers.
	}
}

function retireManager(entry: PoolEntry, slotIndex: number, slot: HealthySlot): void {
	const current = entry.slots[slotIndex];
	if (current.kind !== "healthy" || current.generation !== slot.generation) return;
	const retiring = { manager: current.manager, leases: current.leases };
	entry.slots[slotIndex] = { kind: "vacant" };
	if (retiring.leases === 0) {
		closeManager(retiring.manager);
		return;
	}
	retiringManagers.add(retiring);
}

function releaseReservation(entry: PoolEntry, slotIndex: number, slot: HealthySlot): void {
	const current = entry.slots[slotIndex];
	if (current.kind === "healthy" && current.generation === slot.generation) {
		current.leases--;
		return;
	}
	for (const retiring of retiringManagers) {
		if (retiring.manager !== slot.manager) continue;
		retiring.leases--;
		if (retiring.leases === 0) {
			retiringManagers.delete(retiring);
			closeManager(retiring.manager);
		}
		return;
	}
}

async function createSessionManager(
	baseUrl: string,
	origin: string,
	proxyUrl: string | undefined,
	ca: string | string[] | undefined,
	signal: AbortSignal,
): Promise<Http2SessionManager> {
	const pingOptions = {
		pingIntervalMs: PING_INTERVAL_MS,
		pingTimeoutMs: PING_TIMEOUT_MS,
		pingIdleConnection: true,
	};
	let manager: Http2SessionManager;
	if (proxyUrl) {
		const socket = await connectProxiedSocket(proxyUrl, baseUrl, {
			signal,
			timeoutMs: PROXY_TUNNEL_TIMEOUT_MS,
			ca,
		});
		manager = new Http2SessionManager(origin, pingOptions, { createConnection: () => socket });
	} else if (new URL(baseUrl).protocol === "https:") {
		const socket = await connectDirectSocket(baseUrl, {
			signal,
			timeoutMs: CONNECTION_TIMEOUT_MS,
			ca,
		});
		manager = new Http2SessionManager(origin, pingOptions, { createConnection: () => socket });
	} else {
		manager = new Http2SessionManager(origin, pingOptions);
	}
	const state = await manager.connect();
	if (state === "error") {
		const managerError = manager.error() ?? new Error(`HTTP/2 connection to ${origin} failed`);
		const error =
			managerError && typeof managerError === "object" && "cause" in managerError && managerError.cause
				? managerError.cause
				: managerError;
		closeManager(manager, managerError instanceof Error ? managerError : undefined);
		throw error;
	}
	if (signal.aborted) {
		closeManager(manager, new AIError.AbortError());
		throw new AIError.AbortError();
	}
	return manager;
}

function makeLease(entry: PoolEntry, slotIndex: number, slot: HealthySlot): H2Lease {
	const { generation, manager } = slot;
	let released = false;
	let requested = false;
	const release = (): void => {
		if (released) return;
		released = true;
		const current = entry.slots[slotIndex];
		if (current.kind === "healthy" && current.generation === generation) {
			current.leases = Math.max(0, current.leases - 1);
			if (current.leases === 0) {
				entry.slots[slotIndex] = { kind: "vacant" };
				closeManager(current.manager);
				if (entry.slots.every(candidate => candidate.kind === "vacant")) pools.delete(entry.key);
			}
			return;
		}
		for (const retiring of retiringManagers) {
			if (retiring.manager !== manager) continue;
			retiring.leases = Math.max(0, retiring.leases - 1);
			if (retiring.leases === 0) {
				retiringManagers.delete(retiring);
				closeManager(retiring.manager);
			}
			return;
		}
	};
	return {
		async request(headers, options) {
			if (released) throw new Error("Cannot request from a released HTTP/2 lease");
			if (requested) throw new Error("An HTTP/2 lease owns exactly one active stream");
			requested = true;
			if (options?.signal?.aborted) throw new AIError.AbortError();
			const method = headers[":method"] ?? "POST";
			const path = headers[":path"];
			if (!path) throw new AIError.ValidationError("HTTP/2 request headers require :path");
			const requestHeaders = { ...headers, te: headers.te ?? "trailers" };
			const pending = manager.request(method, path, requestHeaders, {});
			const stream = await waitWithSignal(pending, options?.signal, late => {
				late.close(http2Constants.NGHTTP2_CANCEL);
			});
			const signal = options?.signal;
			const onAbort = (): void => stream.close(http2Constants.NGHTTP2_CANCEL);
			signal?.addEventListener("abort", onAbort, { once: true });
			stream.once("close", () => signal?.removeEventListener("abort", onAbort));
			if (signal?.aborted) {
				onAbort();
				release();
				throw new AIError.AbortError();
			}
			stream.on("data", () => manager.notifyResponseByteRead(stream));
			return stream;
		},
		release,
	};
}

async function waitForInitializer(slot: InitializingSlot, signal: AbortSignal | undefined): Promise<void> {
	slot.waiters++;
	try {
		await waitWithSignal(slot.promise, signal);
	} finally {
		slot.waiters--;
		if (slot.waiters === 0 && signal?.aborted) slot.abort.abort(new AIError.AbortError());
	}
}

async function acquireFromSlot(
	entry: PoolEntry,
	slotIndex: number,
	baseUrl: string,
	origin: string,
	proxyUrl: string | undefined,
	ca: string | string[] | undefined,
	signal: AbortSignal | undefined,
	allowFreshEstablishment: boolean,
): Promise<H2Lease> {
	let slot = entry.slots[slotIndex];
	let reservedSlot: HealthySlot | undefined;
	if (slot.kind === "healthy" && (slot.manager.state() === "error" || slot.manager.state() === "closed")) {
		const error = slot.manager.error() ?? new Error(`HTTP/2 connection to ${origin} is unavailable`);
		retireManager(entry, slotIndex, slot);
		if (!allowFreshEstablishment) throw error;
		slot = entry.slots[slotIndex];
	}
	if (slot.kind === "healthy") {
		reservedSlot = slot;
		slot.leases++;
		let state: Http2ConnectState;
		try {
			state = await waitWithSignal(slot.manager.connect(), signal);
		} catch (error) {
			releaseReservation(entry, slotIndex, slot);
			throw error;
		}
		const current = entry.slots[slotIndex];
		if (state === "error" || current.kind !== "healthy" || current.generation !== slot.generation) {
			const error = slot.manager.error() ?? new Error(`HTTP/2 connection to ${origin} failed`);
			if (current.kind === "healthy" && current.generation === slot.generation) {
				retireManager(entry, slotIndex, slot);
			}
			releaseReservation(entry, slotIndex, slot);
			reservedSlot = undefined;
			if (!allowFreshEstablishment) throw error;
			slot = entry.slots[slotIndex];
		}
	}

	if (slot.kind === "vacant") {
		const generation = nextGeneration++;
		const abort = new AbortController();
		const promise = createSessionManager(baseUrl, origin, proxyUrl, ca, abort.signal);
		const initializing: InitializingSlot = { kind: "initializing", generation, promise, abort, waiters: 0 };
		entry.slots[slotIndex] = initializing;
		promise.then(
			manager => {
				const current = entry.slots[slotIndex];
				if (
					poolDisposing ||
					isTransportDisposed() ||
					current.kind !== "initializing" ||
					current.generation !== generation
				) {
					closeManager(manager);
					return;
				}
				entry.slots[slotIndex] = { kind: "healthy", generation, manager, leases: 0 };
			},
			() => {
				const current = entry.slots[slotIndex];
				if (current.kind === "initializing" && current.generation === generation) {
					entry.slots[slotIndex] = { kind: "vacant" };
					if (entry.slots.every(candidate => candidate.kind === "vacant")) pools.delete(entry.key);
				}
			},
		);
		await waitForInitializer(initializing, signal);
		slot = entry.slots[slotIndex];
	}

	if (slot.kind === "initializing") {
		await waitForInitializer(slot, signal);
		slot = entry.slots[slotIndex];
	}
	if (slot.kind !== "healthy") throw new Error("HTTP/2 pool slot did not become healthy");
	if (signal?.aborted) {
		if (reservedSlot) releaseReservation(entry, slotIndex, reservedSlot);
		throw new AIError.AbortError();
	}
	if (!reservedSlot) slot.leases++;
	return makeLease(entry, slotIndex, slot);
}

let disposerRegistered = false;
function ensureDisposerRegistered(): void {
	if (disposerRegistered) return;
	disposerRegistered = true;
	registerTransportDisposer("h2-pool", disposeH2Pool);
}

/** Test seam for asserting that failed origins and proxy credentials are not retained. */
export function getH2PoolSizeForTest(): number {
	return pools.size;
}

export async function acquireH2Session(
	baseUrl: string,
	provider: string,
	options?: H2SessionOptions,
): Promise<H2Lease> {
	// Registered on first use, not at import: `@oh-my-pi/pi-ai` re-exports this
	// module, so registering at module scope would install a process-level
	// postmortem hook in every consumer that merely imports the package —
	// including ones that never open a connection. Nothing needs disposing
	// until a session exists.
	ensureDisposerRegistered();
	if (poolDisposing || isTransportDisposed()) throw new Error("HTTP/2 transport has been disposed");
	const signal = options?.signal;
	if (signal?.aborted) throw new AIError.AbortError();
	const url = new URL(baseUrl);
	const origin = `${url.protocol}//${url.host}`;
	const proxyUrl = getProxyForUrl(provider, url);
	const ca = options?.ca;
	const caKey = ca ? Bun.hash(Array.isArray(ca) ? ca.join("\0") : ca) : "";
	const key = `${origin}|${proxyUrl ?? ""}|${caKey}`;
	let entry = pools.get(key);
	if (!entry) {
		entry = { key, slots: Array.from({ length: POOL_SIZE }, () => ({ kind: "vacant" })), roundRobin: 0 };
		pools.set(key, entry);
	}

	const slotOrder = Array.from({ length: POOL_SIZE }, (_, attempt) => (entry.roundRobin + attempt) % POOL_SIZE);
	const occupied = slotOrder.filter(slotIndex => entry.slots[slotIndex]?.kind !== "vacant");
	let originatingError: unknown;
	for (const slotIndex of occupied) {
		try {
			const lease = await acquireFromSlot(entry, slotIndex, baseUrl, origin, proxyUrl, ca, signal, false);
			entry.roundRobin = (slotIndex + 1) % POOL_SIZE;
			return lease;
		} catch (error) {
			if (error instanceof AIError.AbortError) throw error;
			originatingError ??= error;
		}
	}

	const vacantIndex = slotOrder.find(slotIndex => entry.slots[slotIndex]?.kind === "vacant");
	if (vacantIndex !== undefined) {
		try {
			const lease = await acquireFromSlot(entry, vacantIndex, baseUrl, origin, proxyUrl, ca, signal, true);
			entry.roundRobin = (vacantIndex + 1) % POOL_SIZE;
			return lease;
		} catch (error) {
			if (error instanceof AIError.AbortError) throw error;
			originatingError ??= error;
		}
	}
	throw originatingError ?? new Error("HTTP/2 session acquisition failed");
}

export function disposeH2Pool(): Promise<void> {
	if (poolDisposalPromise) return poolDisposalPromise;
	poolDisposing = true;
	poolDisposalPromise = (async () => {
		try {
			const reason = new Error("HTTP/2 pool disposed");
			const initializers: Promise<unknown>[] = [];
			for (const entry of pools.values()) {
				for (const slot of entry.slots) {
					if (slot.kind === "healthy") closeManager(slot.manager, reason);
					else if (slot.kind === "initializing") {
						slot.abort.abort(reason);
						initializers.push(slot.promise.catch(() => undefined));
					}
				}
			}
			for (const retiring of retiringManagers) closeManager(retiring.manager, reason);
			pools.clear();
			retiringManagers.clear();
			await Promise.all(initializers);
		} finally {
			poolDisposing = false;
			poolDisposalPromise = undefined;
		}
	})();
	return poolDisposalPromise;
}
