import type { AgentDefinition } from "./types";
import { isToolDisallowed } from "../tools/builtin-names";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"hub",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	// Classify from the EFFECTIVE tool set: `disallowedTools:` can remove a
	// mutating tool (e.g. `tools: [read, write]` + `disallowedTools: [write]`),
	// leaving a read-only scope that the declared list alone would mark
	// writable — and the parent uses this to decide whether it may assign
	// edits to the child. Fail-safe: an empty effective set is NOT read-only
	// (no declared tools means full inheritance).
	const patterns = agent.disallowedTools ?? [];
	const effective = agent.tools?.filter(tool => !isToolDisallowed(tool, patterns));
	return !!effective?.length && effective.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}
