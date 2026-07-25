import { postmortem } from "@oh-my-pi/pi-utils";

var transportDisposer: (() => Promise<void>) | undefined;
var registered = false;
var disposing = false;
var disposed = false;
var disposalPromise: Promise<void> | undefined;

import { __resetH2Pool, disposeCursorH2Pool } from "./h2-pool";
import { __resetH1Bridges, disposeH1Bridges } from "./http1-bridge";
import { __resetServerConfigCache, disposeServerConfigCache } from "./server-config";

export function isCursorTransportDisposed(): boolean {
	return disposed || disposing;
}

/**
 * Register the single transport disposer. Called once by the H2 pool module
 * when it initializes. The disposer closes all pooled H2 sessions, evicts
 * config cache entries, and aborts any active H1 bridges.
 *
 * Rejects re-registration while disposal is in progress: the active disposal
 * must drain to completion before a new disposer can be installed.
 */
export function setCursorTransportDisposer(disposer: () => Promise<void>): void {
	if (disposing || disposed || disposalPromise !== undefined) {
		throw new Error("Cannot register Cursor transport disposer during disposal");
	}
	transportDisposer = disposer;
	if (!registered) {
		postmortem.register("cursor-h2-pool", async () => {
			await disposeCursorTransport();
		});
		registered = true;
	}
}

/**
 * Dispose all Cursor transport resources. Blocks new work, aborts/awaits
 * config entries and H1 bridges, retires/awaits every slot and detached
 * retiring manager, and clears registries. Idempotent.
 */
export function disposeCursorTransport(): Promise<void> {
	if (disposalPromise) {
		return disposalPromise;
	}
	disposing = true;
	disposalPromise = (async () => {
		try {
			const fn = transportDisposer;
			transportDisposer = undefined;
			await Promise.allSettled([fn ? fn() : disposeCursorH2Pool(), disposeServerConfigCache(), disposeH1Bridges()]);
			disposed = true;
		} finally {
			disposing = false;
		}
	})();
	return disposalPromise;
}

export function __resetCursorTransportForTests(): void {
	disposing = false;
	disposed = false;
	transportDisposer = undefined;
	disposalPromise = undefined;
	__resetH2Pool();
	__resetServerConfigCache();
	__resetH1Bridges();
}
