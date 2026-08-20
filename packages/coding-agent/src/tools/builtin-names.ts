export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"eval",
	"github",
	"glob",
	"grep",
	"lsp",
	"inspect_image",
	"browser",
	"computer",
	"checkpoint",
	"rewind",
	"security_scan",
	"task",
	"hub",
	"todo",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["search", "grep"],
	["find", "glob"],
]);

const CANONICAL_TOOL_NAMES: Record<string, true> = Object.fromEntries(
	[...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, true]),
);

/** Canonicalize built-in IDs, legacy aliases, and MCP minted names. Leave plugin names unchanged. */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return (
		LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(lower) ??
		(Object.hasOwn(CANONICAL_TOOL_NAMES, lower) || lower.startsWith("mcp__") ? lower : name)
	);
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

/**
 * Match a tool name against disallow patterns: a trailing `*` is a prefix
 * wildcard (`mcp__*` = all MCP tools, `mcp__<server>_*` = one server), any
 * other pattern matches the exact name.
 *
 * Hidden protocol tools (`yield`, `goal`, `think`) are never disallowable:
 * stripping the subagent terminator would leave a `requireYieldTool` session
 * unable to yield. The `<server>` in an `mcp__<server>_*` pattern is the
 * sanitized tool-name prefix (`createMCPToolName` lowercases and collapses
 * non-`[a-z_]` characters), not the raw config server name — a server named
 * `db2` mints `mcp__db_query`, so the pattern is `mcp__db_*`.
 */
export function isToolDisallowed(name: string, patterns: readonly string[]): boolean {
	if (HIDDEN_TOOL_NAMES.includes(name as HiddenToolName)) return false;
	for (const pattern of patterns) {
		if (pattern.endsWith("*")) {
			if (name.startsWith(pattern.slice(0, -1))) return true;
		} else if (name === pattern) {
			return true;
		}
	}
	return false;
}
