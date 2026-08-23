/**
 * Shared conversions for applying an agent definition's frontmatter to the
 * MAIN session (as opposed to a subagent spawn). `parseAgentFields` appends
 * `yield` to every explicit tool list because subagents need it to submit
 * results; the main session has no parent executor to consume a yield, so the
 * subagent-only tools are stripped before the persona's toolset is applied.
 */
export function mainSessionTools(tools: string[]): string[] {
	return tools.filter(name => name !== "yield" && name !== "goal");
}

/** Serialize an agent's `spawns` frontmatter to the session's spawn string. */
export function spawnsToString(spawns: string[] | "*" | undefined): string {
	return spawns === "*" ? "*" : spawns ? spawns.join(",") : "*";
}
