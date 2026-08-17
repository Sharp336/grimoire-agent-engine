import { SocketPeerTransportBackend, SocketRemoteRegistryBackend, SocketStructuredSubagentBackend } from "./backends";
import { RemoteRuntimeClient } from "./client";
import { loadRemoteRuntimeConfig, type RemoteRuntimeConfig } from "./config";
import { type RemoteRuntimeBindings, runWithSealedRemoteRuntime } from "./scope";

export interface RemoteRuntimeInstallation {
	readonly bindings: RemoteRuntimeBindings;
	readonly client: RemoteRuntimeClient;
}

/** Construct one immutable backend set without installing process-global state. */
export function createRemoteRuntimeInstallation(
	config: RemoteRuntimeConfig,
	client: RemoteRuntimeClient = new RemoteRuntimeClient(config),
): RemoteRuntimeInstallation {
	const registryBackend = new SocketRemoteRegistryBackend(client);
	const bindings: RemoteRuntimeBindings = Object.freeze({
		subagentBackend: new SocketStructuredSubagentBackend(client, config, registryBackend),
		registryBackend,
		peerTransport: new SocketPeerTransportBackend(client, config),
	});
	return Object.freeze({ bindings, client });
}

/**
 * Load and authenticate the launch-owned descriptor before command/session
 * construction, bind all remote seams for callback, then close only this
 * installation's client after the asynchronous scope has been removed.
 */
export async function runWithRemoteRuntimeConfig<T>(configPath: string, callback: () => Promise<T>): Promise<T> {
	const config = await loadRemoteRuntimeConfig(configPath);
	const installation = createRemoteRuntimeInstallation(config);
	try {
		return await runWithSealedRemoteRuntime(installation.bindings, async () => {
			await installation.client.start();
			return callback();
		});
	} finally {
		installation.client.close();
	}
}
