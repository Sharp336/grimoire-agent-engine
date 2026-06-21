import type { Client } from "@libsql/client";
import { logger } from "@oh-my-pi/pi-utils";
import type { CodemapConfig } from "./config";
import { initSchema } from "./schema";

/**
 * Open a libSQL/Turso client for the codemap summaries store.
 *
 * Connection resolution order:
 *   1. If `turso.syncUrl` + `turso.authToken` are set → embedded replica mode
 *      (local file + remote sync).
 *   2. Otherwise → local file-only mode.
 *
 * After opening, runs schema bootstrap (initSchema) and — for embedded replica
 * mode — an initial sync + post-sync maintenance.
 */
export async function openCodemapDb(config: CodemapConfig): Promise<Client> {
	// Dynamic import: @libsql/client loads a native NAPI binding (libsql) that
	// must NOT load at CLI startup when codemap is disabled. Matches the
	// loadFastembedOnce pattern in mnemopi/src/core/fastembed-runtime.ts:59-77
	// — optional native peers are lazy-loaded via `await import()`.
	const { createClient } = await import("@libsql/client");
	const hasTursoSync = config.turso.syncUrl && config.turso.authToken;
	const client = createClient({
		url: `file:${config.dbPath}`,
		...(hasTursoSync ? { syncUrl: config.turso.syncUrl, authToken: config.turso.authToken } : {}),
	});

	// Schema bootstrap
	await initSchema(client);

	if (hasTursoSync) {
		try {
			await client.sync();
			await postSyncMaintenance(client);
		} catch (err) {
			logger.warn("codemap: initial Turso sync failed, continuing with local-only", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return client;
}

/**
 * Rebuild FTS5 index and vector index after a remote sync.
 *
 * libSQL's `client.sync()` applies a remote changeset to the local embedded
 * replica at a low level. This application path does NOT fire SQL triggers
 * (triggers only fire on local DML executed via the connection, not on
 * replica apply). Since the FTS5 external-content table relies on triggers
 * and the DiskANN vector index relies on base-table change notifications,
 * BOTH indexes can be stale after a sync that pulled remote-side writes.
 */
export async function postSyncMaintenance(client: Client): Promise<void> {
	// Rebuild FTS5 external-content index from the base table.
	await client.execute("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')");
	// Rebuild the DiskANN vector index from scratch.
	await client.execute("REINDEX idx_summaries_embedding");
}

/** Close the codemap DB client gracefully. */
export async function closeCodemapDb(client: Client): Promise<void> {
	try {
		await client.close();
	} catch {
		// Already closed.
	}
}
