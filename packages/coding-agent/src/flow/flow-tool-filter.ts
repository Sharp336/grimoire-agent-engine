/**
 * Flow tool filter.
 *
 * Given a parent tool scope and a node's `available_tools` filter, compute
 * the effective tool set for the frame. Semantics:
 *
 *  - `filter === undefined` → pass-through (inherit parent scope).
 *  - `filter` is a list of entries processed in order. Each entry is either
 *    `"name"` (allow) or `"!name"` (deny). Allow entries add to the
 *    working set; deny entries remove. Later entries override earlier ones.
 *  - A `"*"` wildcard is supported on both sides (e.g. `"mcp_*"`, `"!mcp_*"`).
 *  - Unknown names in an allow list are silently ignored (the tool is simply
 *    not present in the parent scope).
 *  - If the filter contains no allow entries but has deny entries, the
 *    starting set is the parent scope (deny-only mode). If the filter has
 *    any allow entry, the starting set is empty and allow entries opt tools
 *    in one by one.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";

/** Convert a glob with `*` wildcards to an anchored RegExp. */
function globToRegex(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function matchesName(pattern: string, name: string): boolean {
	if (!pattern.includes("*")) return pattern === name;
	return globToRegex(pattern).test(name);
}

export function applyToolFilter(
	parentScope: readonly AgentTool<any>[],
	filter: readonly string[] | undefined,
): AgentTool<any>[] {
	if (filter === undefined) return [...parentScope];
	if (filter.length === 0) return [...parentScope];

	const hasAllow = filter.some(e => !e.startsWith("!"));
	// Deny-only starts from the parent scope; allow-mode starts empty.
	let working: AgentTool<any>[] = hasAllow ? [] : [...parentScope];

	for (const entry of filter) {
		if (entry.startsWith("!")) {
			const pat = entry.slice(1);
			working = working.filter(t => !matchesName(pat, t.name));
		} else {
			// Allow: find any tool in parentScope matching the pattern that
			// is not already in `working`, and add it.
			for (const tool of parentScope) {
				if (matchesName(entry, tool.name) && !working.includes(tool)) {
					working.push(tool);
				}
			}
		}
	}

	return working;
}
