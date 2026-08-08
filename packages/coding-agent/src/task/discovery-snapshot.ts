import * as path from "node:path";
import type { AgentDefinition } from "./types";

export type ExtensionDiscoveryMode = "explicit-only" | "merge";

/**
 * Memoized agent definitions per (cwd, extension mode), published by the task
 * tool's discovery pipeline (`discoverAgentsForCreate` / `refreshAgentDiscovery`).
 * Lives in its own module so both the task barrel and the prompt-side
 * scout-availability checks (tools, sdk) can read the same snapshot the task
 * tool advertises without a task↔tools import cycle.
 *
 * Keyed by extension mode as well as cwd: an `--no-extensions` session
 * (`explicit-only`) suppresses ambient marketplace-plugin roots, so its
 * snapshot must not be cross-contaminated by a merge-mode session's discovery
 * in the same process.
 */
const discoverySnapshots = new Map<string, AgentDefinition[]>();

function snapshotKey(cwd: string, extensionMode: ExtensionDiscoveryMode): string {
	return `${path.resolve(cwd)}\0${extensionMode}`;
}

/** Definitions snapshot for a cwd, or undefined before discovery completes. */
export function getDiscoveredAgentsSnapshot(
	cwd: string,
	extensionMode: ExtensionDiscoveryMode = "merge",
): AgentDefinition[] | undefined {
	return discoverySnapshots.get(snapshotKey(cwd, extensionMode));
}

/** Publish a completed discovery result for a cwd. */
export function setDiscoveredAgentsSnapshot(
	cwd: string,
	agents: AgentDefinition[],
	extensionMode: ExtensionDiscoveryMode = "merge",
): void {
	discoverySnapshots.set(snapshotKey(cwd, extensionMode), agents);
}

/** Drop all cached snapshots (discovery binding changes / explicit reloads). */
export function clearDiscoveredAgentSnapshots(): void {
	discoverySnapshots.clear();
}
