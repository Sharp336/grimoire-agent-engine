import { AsyncLocalStorage } from "node:async_hooks";
import type { PeerTransportBackend } from "../irc/bus";
import type { RemoteRegistryBackend } from "../registry/agent-registry";
import type { StructuredSubagentBackend } from "../task/structured-subagent";

/** Backends installed for exactly one sealed runtime invocation. */
export interface RemoteRuntimeBindings {
	readonly subagentBackend: StructuredSubagentBackend;
	readonly registryBackend: RemoteRegistryBackend;
	readonly peerTransport: PeerTransportBackend;
}

const remoteRuntimeStorage = new AsyncLocalStorage<RemoteRuntimeBindings>();
let sealedRuntimeActive = false;

/** Whether a config-sealed process must reject missing async-local authority. */
export function remoteRuntimeSealActive(): boolean {
	return sealedRuntimeActive;
}

/** Install the one process-sealing scope created from a launch descriptor. */
export async function runWithSealedRemoteRuntime<T>(
	bindings: RemoteRuntimeBindings,
	callback: () => Promise<T>,
): Promise<T> {
	if (sealedRuntimeActive) {
		throw new Error("A config-sealed remote runtime is already active in this process.");
	}
	sealedRuntimeActive = true;
	try {
		return await runWithRemoteRuntime(bindings, callback);
	} finally {
		sealedRuntimeActive = false;
	}
}

/** Return the sealed runtime bound to the current asynchronous command scope. */
export function currentRemoteRuntime(): RemoteRuntimeBindings | undefined {
	return remoteRuntimeStorage.getStore();
}

/**
 * Install one immutable backend set for the lifetime of callback. Async-local
 * scope keeps concurrent SDK/CLI sessions isolated and removes the exact
 * installed set automatically when callback settles.
 */
export function runWithRemoteRuntime<T>(bindings: RemoteRuntimeBindings, callback: () => T): T {
	if (remoteRuntimeStorage.getStore()) {
		throw new Error("A sealed remote runtime is already installed for this command scope.");
	}
	return remoteRuntimeStorage.run(Object.freeze(bindings), callback);
}
