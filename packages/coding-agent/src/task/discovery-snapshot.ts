/**
 * Shared discovery-snapshot store for the discovered agent roster, keyed by
 * resolved cwd. `TaskTool.create` / `refreshAgentDiscovery` publish the
 * discovered definitions here; sibling surfaces that advertise the scout
 * shortcut (system prompt, grep/glob/ast-grep tool descriptions, session
 * plan-mode flags) read the scout definition's availability synchronously
 * without importing the task tool module (which would create an import cycle
 * through the tools barrel).
 */
import type { AgentDefinition } from "./types";

const discoverySnapshots = new Map<string, AgentDefinition[]>();

/** Publish the discovered roster for a cwd (replaces any prior snapshot). */
export function publishDiscoveredAgents(cwd: string, agents: AgentDefinition[]): void {
	discoverySnapshots.set(cwd, agents);
}

/** The discovered roster for a cwd, or `[]` when discovery has not run for it yet. */
export function getDiscoveredAgents(cwd: string): AgentDefinition[] {
	return discoverySnapshots.get(cwd) ?? [];
}

/**
 * The discovered `scout` definition for a cwd, or `undefined` when discovery
 * has not run for it yet (no TaskTool created / no refresh). Surfaces that
 * advertise the scout shortcut read this to honor a project override that
 * makes the bundled scout primary-only/unavailable.
 */
export function getDiscoveredScoutAgent(cwd: string): AgentDefinition | undefined {
	return getDiscoveredAgents(cwd).find(agent => agent.name === "scout");
}
