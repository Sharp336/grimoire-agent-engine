import { PsHost } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Session-keyed pool of persistent PowerShell hosts.
 *
 * Each agent session gets at most one warm `pwsh` sidecar (one shared runspace),
 * lazily spawned on first use and reused across tool calls so command state
 * persists. The performance-critical path (`PsHost.run`) and call serialization
 * live in the native layer; this manager is pure coordination: lazy spawn,
 * reuse, idle eviction, and graceful disposal.
 *
 * Lifecycle guarantees:
 * - Hosts unused beyond `idleTtlMs` are evicted on the next acquire (no timers).
 * - The native host carries a parent-PID watchdog, so a hard omp crash can never
 *   orphan a sidecar — it self-terminates when this process dies. {@link
 *   disposeAllPsHosts} is the graceful path for an orderly shutdown.
 */

interface HostEntry {
	host: PsHost;
	lastUsed: number;
}

const HOSTS = new Map<string, HostEntry>();

export interface AcquirePsHostOptions {
	/** Stable per-session key; distinct sessions get distinct hosts. */
	sessionId: string;
	/** Initial working directory for a freshly spawned host. */
	cwd: string;
	/** Override for the pwsh executable; defaults to `pwsh` on PATH. */
	shellPath?: string;
	/** Retained-result history cap for a freshly spawned host. */
	historyDepth: number;
	/** Evict hosts idle longer than this (ms); `<= 0` disables eviction. */
	idleTtlMs: number;
}

/** Get the session's warm host, spawning and starting one on first use. */
export async function acquirePsHost(options: AcquirePsHostOptions): Promise<PsHost> {
	sweepIdle(options.idleTtlMs, options.sessionId);

	const existing = HOSTS.get(options.sessionId);
	if (existing) {
		existing.lastUsed = Date.now();
		return existing.host;
	}

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
	HOSTS.set(options.sessionId, { host, lastUsed: Date.now() });
	return host;
}

/** Dispose one session's host (e.g. on session teardown). */
export async function disposePsHostSession(sessionId: string): Promise<void> {
	const entry = HOSTS.get(sessionId);
	if (!entry) return;
	HOSTS.delete(sessionId);
	await safeDispose(entry.host);
}

/** Dispose every pooled host. Wire into the app's orderly-shutdown path. */
export async function disposeAllPsHosts(): Promise<void> {
	const entries = [...HOSTS.values()];
	HOSTS.clear();
	await Promise.allSettled(entries.map(entry => safeDispose(entry.host)));
}

function sweepIdle(ttlMs: number, keep: string): void {
	if (ttlMs <= 0) return;
	const now = Date.now();
	for (const [id, entry] of HOSTS) {
		if (id === keep) continue;
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
