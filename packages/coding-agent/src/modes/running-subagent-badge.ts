import { AgentRegistry } from "../registry/agent-registry";

export function getRunningSubagentBadgeRegistry(): AgentRegistry {
	return AgentRegistry.global();
}

export function countRunningSubagentBadgeAgents(registry: AgentRegistry): number {
	return registry.list().filter(ref => ref.kind === "sub" && ref.status === "running").length;
}
