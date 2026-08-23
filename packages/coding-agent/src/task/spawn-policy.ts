import type { AgentDefinition } from "./types";

/** Default agent used when a session has unrestricted spawning. */
export const DEFAULT_SPAWN_AGENT = "task";

/** Spawn policy derived from a parent agent's `spawns` frontmatter. */
export interface ResolvedSpawnPolicy {
	/** True when at least one subagent may be spawned. */
	enabled: boolean;
	/** Agent used when the caller omits the agent field. */
	defaultAgent: string;
	/** Explicitly allowed agents, or `null` when the policy is unrestricted. */
	allowedAgents: readonly string[] | null;
	/** Text used in spawn rejection messages. */
	allowedErrorText: string;
	/** Backtick-quoted explicit agents for prompt descriptions. */
	allowedPromptText?: string;
}

/** Resolves spawn frontmatter into the default and prompt/error surfaces. */
export function resolveSpawnPolicy(parentSpawns: string | boolean | null | undefined): ResolvedSpawnPolicy {
	let normalized: string;
	if (parentSpawns === false) {
		normalized = "";
	} else if (parentSpawns === true || parentSpawns === null || parentSpawns === undefined) {
		normalized = "*";
	} else {
		normalized = parentSpawns.trim();
	}

	if (normalized === "*") {
		return {
			enabled: true,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents: null,
			allowedErrorText: "*",
		};
	}

	const allowedAgents = normalized
		.split(",")
		.map(spawn => spawn.trim())
		.filter(Boolean);
	if (allowedAgents.length === 0) {
		return {
			enabled: false,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents,
			allowedErrorText: "none (spawns disabled for this agent)",
		};
	}

	return {
		enabled: true,
		defaultAgent: allowedAgents[0] ?? DEFAULT_SPAWN_AGENT,
		allowedAgents,
		allowedErrorText: allowedAgents.join(","),
		allowedPromptText: allowedAgents.map(agent => `\`${agent}\``).join(", "),
	};
}

/**
 * Whether an agent definition can be spawned as a subagent: not
 * primary/unavailable (structured-subagent preflight rejects those), not
 * disabled via `task.disabledAgents`, and permitted by the spawn policy.
 */
export function isSpawnableAgent(
	agent: AgentDefinition,
	spawnPolicy: ResolvedSpawnPolicy,
	disabledAgents: readonly string[] | undefined,
): boolean {
	if (agent.availability === "primary" || agent.availability === "unavailable") return false;
	if (disabledAgents?.includes(agent.name)) return false;
	return spawnPolicy.allowedAgents === null || spawnPolicy.allowedAgents.includes(agent.name);
}

/**
 * The agent a spawn defaults to when the caller omits `agent`, derived from
 * SPAWNABLE agents only. The raw policy default comes from the parent's
 * `spawns` frontmatter and may name an agent that cannot actually be spawned
 * (primary-only/unavailable, disabled, or not in the allowed list) — the task
 * schema and execute path must never fill that unspawnable default, or every
 * omitted-agent call fails preflight. Returns the policy default when it is
 * spawnable, else the first spawnable agent, else `undefined` (no spawnable
 * agents remain).
 */
export function resolveEffectiveDefaultAgent(
	spawnPolicy: ResolvedSpawnPolicy,
	agents: readonly AgentDefinition[],
	disabledAgents: readonly string[] | undefined,
): string | undefined {
	if (!spawnPolicy.enabled) return undefined;
	const spawnable = agents.filter(agent => isSpawnableAgent(agent, spawnPolicy, disabledAgents));
	if (spawnable.length === 0) return undefined;
	if (spawnable.some(agent => agent.name === spawnPolicy.defaultAgent)) return spawnPolicy.defaultAgent;
	return spawnable[0]!.name;
}

/**
 * Whether the `scout` agent is spawnable in a session: not disabled via
 * `task.disabledAgents`, and permitted by the session spawn policy.
 */
export function isScoutSpawnable(
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
): boolean {
	if (disabledAgents?.includes("scout")) return false;
	const policy = resolveSpawnPolicy(spawns);
	if (!policy.enabled) return false;
	return policy.allowedAgents === null || policy.allowedAgents.includes("scout");
}
