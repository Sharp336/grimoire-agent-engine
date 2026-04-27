/**
 * Helpers for the MCP `roots` capability.
 *
 * These are kept in their own module so both the manager (which owns active
 * connections) and the client (which serves probe-only fallback handlers)
 * agree on the response shape and notification dispatch without forming a
 * circular import.
 */
import * as path from "node:path";
import * as url from "node:url";
import { logger } from "@oh-my-pi/pi-utils";
import type { MCPServerConnection } from "./types";
import { MCPNotificationMethods } from "./types";

/**
 * MCP root descriptor (subset of the spec we currently emit).
 */
export interface MCPRoot {
	uri: string;
	name: string;
}

/**
 * Build the `roots/list` response shape for the given working directory.
 * Single-root convention: the agent exposes its current cwd as the only root.
 */
export function buildRootsList(cwd: string): { roots: MCPRoot[] } {
	return {
		roots: [
			{
				uri: url.pathToFileURL(cwd).href,
				name: path.basename(cwd),
			},
		],
	};
}

/**
 * Best-effort fan-out of `notifications/roots/list_changed` to every connection.
 *
 * - Skips disconnected transports (notify on a closed transport would throw).
 * - Per-connection failures are logged at debug and never abort the broadcast.
 * - Resolves once all attempts have settled so callers can `await` for tests.
 */
export async function notifyRootsChanged(connections: Iterable<MCPServerConnection>): Promise<void> {
	const tasks: Promise<unknown>[] = [];
	for (const connection of connections) {
		if (!connection.transport.connected) continue;
		tasks.push(
			connection.transport.notify(MCPNotificationMethods.ROOTS_LIST_CHANGED).catch(error => {
				logger.debug("Failed to send roots/list_changed", { path: `mcp:${connection.name}`, error });
			}),
		);
	}
	await Promise.allSettled(tasks);
}
