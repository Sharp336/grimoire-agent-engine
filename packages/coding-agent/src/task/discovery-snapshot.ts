import * as path from "node:path";
import type { AgentDefinition } from "./types";

/**
 * Memoized agent definitions per cwd, published by the task tool's discovery
 * pipeline (`discoverAgentsForCreate` / `refreshAgentDiscovery`). Lives in its
 * own module so both the task barrel and the prompt-side scout-availability
 * checks (tools, sdk) can read the same snapshot the task tool advertises
 * without a task↔tools import cycle.
 */
const discoverySnapshots = new Map<string, AgentDefinition[]>();

/** Definitions snapshot for a cwd, or undefined before discovery completes. */
export function getDiscoveredAgentsSnapshot(cwd: string): AgentDefinition[] | undefined {
	return discoverySnapshots.get(path.resolve(cwd));
}

/** Publish a completed discovery result for a cwd. */
export function setDiscoveredAgentsSnapshot(cwd: string, agents: AgentDefinition[]): void {
	discoverySnapshots.set(path.resolve(cwd), agents);
}

/** Drop all cached snapshots (discovery binding changes / explicit reloads). */
export function clearDiscoveredAgentSnapshots(): void {
	discoverySnapshots.clear();
}
