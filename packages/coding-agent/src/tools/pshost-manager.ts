import { PsHost } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Session-keyed pool of persistent PowerShell hosts, plus tracking for
 * ephemeral (single-call, never pooled) hosts.
 *
 * Each agent session gets at most one warm `pwsh` sidecar (one shared runspace),
 * lazily spawned on first use and reused across tool calls so command state
 * persists. The performance-critical path (`PsHost.run`) and call serialization
 * live in the native layer; this manager is pure coordination: lazy spawn,
 * reuse, idle eviction, and graceful disposal.
 *
 * Lifecycle guarantees:
 * - Hosts unused beyond `idleTtlMs` are evicted on the next acquire (no timers).
 *   A host with an in-flight run is never evicted, however long it takes; its
 *   idle clock restarts when the lease is released.
 * - An ephemeral host lives for exactly one run; its `dispose()` resolves only
 *   when the process is fully gone, so file locks and loaded assemblies are
 *   deterministically released before the caller continues.
 * - The native host carries a parent-PID watchdog, so a hard omp crash can never
 *   orphan a sidecar — it self-terminates when this process dies. {@link
 *   disposeAllPsHosts} is the graceful path for an orderly shutdown.
 */

interface HostEntry {
	host: PsHost;
	lastUsed: number;
	/** In-flight run count; a busy host is never idle-evicted. */
	activeRuns: number;
}

const HOSTS = new Map<string, HostEntry>();
/** Live ephemeral hosts, tracked only so orderly shutdown can reap them. */
const EPHEMERAL_HOSTS = new Set<PsHost>();

export interface SpawnPsHostOptions {
	/** Initial working directory for the spawned host. */
	cwd: string;
	/** Override for the pwsh executable; defaults to `pwsh` on PATH. */
	shellPath?: string;
	/** Retained-result history cap for the spawned host. */
	historyDepth: number;
}

export interface AcquirePsHostOptions extends SpawnPsHostOptions {
	/** Stable per-session key; distinct sessions get distinct hosts. */
	sessionId: string;
	/** Evict hosts idle longer than this (ms); `<= 0` disables eviction. */
	idleTtlMs: number;
}

export interface PsHostLease {
	host: PsHost;
	/** Return the host to the pool; refreshes its idle timestamp. */
	release(): void;
}

export interface EphemeralPsHostLease {
	host: PsHost;
	/** Terminate the host; resolves only once the process is fully gone. */
	dispose(): Promise<void>;
}

async function spawnHost(options: SpawnPsHostOptions): Promise<PsHost> {
	const host = new PsHost({
		parentPid: process.pid,
		shellPath: options.shellPath,
		cwd: options.cwd,
		historyDepth: options.historyDepth,
	});
	try {
		await host.start();
	} catch (err) {
		await safeDispose(host);
		throw err;
	}
	return host;
}

/** Get the session's warm host, spawning and starting one on first use. */
export async function acquirePsHost(options: AcquirePsHostOptions): Promise<PsHostLease> {
	sweepIdle(options.idleTtlMs, options.sessionId);

	let entry = HOSTS.get(options.sessionId);
	if (!entry) {
		entry = { host: await spawnHost(options), lastUsed: Date.now(), activeRuns: 0 };
		HOSTS.set(options.sessionId, entry);
	}

	entry.lastUsed = Date.now();
	entry.activeRuns++;
	let released = false;
	return {
		host: entry.host,
		release: () => {
			if (released) return;
			released = true;
			entry.activeRuns--;
			entry.lastUsed = Date.now();
		},
	};
}

/**
 * Spawn a throwaway host for a single run. Never pooled and invisible to the
 * session host; the caller must await `dispose()` when the run completes.
 */
export async function spawnEphemeralPsHost(options: SpawnPsHostOptions): Promise<EphemeralPsHostLease> {
	const host = await spawnHost(options);
	EPHEMERAL_HOSTS.add(host);
	return {
		host,
		dispose: async () => {
			EPHEMERAL_HOSTS.delete(host);
			await safeDispose(host);
		},
	};
}

/** Dispose one session's host (e.g. on session teardown). */
export async function disposePsHostSession(sessionId: string): Promise<void> {
	const entry = HOSTS.get(sessionId);
	if (!entry) return;
	HOSTS.delete(sessionId);
	await safeDispose(entry.host);
}

/** Dispose every pooled and ephemeral host. Wire into the app's orderly-shutdown path. */
export async function disposeAllPsHosts(): Promise<void> {
	const hosts = [...HOSTS.values()].map(entry => entry.host).concat([...EPHEMERAL_HOSTS]);
	HOSTS.clear();
	EPHEMERAL_HOSTS.clear();
	await Promise.allSettled(hosts.map(host => safeDispose(host)));
}

function sweepIdle(ttlMs: number, keep: string): void {
	if (ttlMs <= 0) return;
	const now = Date.now();
	for (const [id, entry] of HOSTS) {
		if (id === keep || entry.activeRuns > 0) continue;
		if (now - entry.lastUsed > ttlMs) {
			HOSTS.delete(id);
			void safeDispose(entry.host);
		}
	}
}

async function safeDispose(host: PsHost): Promise<void> {
	try {
		await host.dispose();
	} catch (err) {
		logger.warn("PowerShell host dispose failed", { error: String(err) });
	}
}
