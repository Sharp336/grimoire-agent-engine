import type { ConfiguredThinkingLevel } from "../thinking";
import type { AgentDefinition } from "./types";

export interface AgentSessionPolicy {
	/** Tool names to activate (undefined = keep current set). */
	toolNames?: string[];
	/** Spawn allowlist serialized for ToolSession.getSessionSpawns (undefined = keep current). */
	spawns?: string;
	/** Model pattern(s) from frontmatter (undefined = keep current). */
	modelPatterns?: string[];
	/** Thinking level from frontmatter (undefined = keep current). */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Agent system prompt body, appended to the default prompt via appendParts. */
	systemPromptBody: string;
}

/**
 * Resolve an AgentDefinition into session-level policy fields.
 * Shared by main-agent selection and (future) subagent policy resolution.
 */
export function resolveAgentSessionPolicy(agent: AgentDefinition): AgentSessionPolicy {
	// Spawns: replicate executor.ts:2272-2278, but main persona: absent spawns → "*"
	const spawns =
		agent.spawns === undefined
			? "*"
			: agent.spawns === "*"
				? "*"
				: agent.spawns.length === 0
					? ""
					: agent.spawns.join(",");

	// Tools: replicate executor.ts:2244-2268 logic.
	// Auto-add `task` when spawning is enabled (resolved spawns is non-empty),
	// so a persona with explicit tools but no `spawns` field can still spawn.
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = [...agent.tools];
		// `yield` is auto-added by parseAgentFields for non-primary agents
		// (helpers.ts:271) but has no meaningful behavior in the main session.
		toolNames = toolNames.filter(n => n !== "yield");
		if (spawns && spawns !== "" && !toolNames.includes("task")) {
			toolNames = [...toolNames, "task"];
		}
		if (!toolNames.includes("hub")) {
			toolNames = [...toolNames, "hub"];
		}
	}

	return {
		toolNames,
		spawns,
		modelPatterns: agent.model,
		thinkingLevel: agent.thinkingLevel,
		systemPromptBody: agent.systemPrompt,
	};
}
