export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"launch",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"eval",
	"ssh",
	"github",
	"glob",
	"grep",
	"lsp",
	"inspect_image",
	"browser",
	"checkpoint",
	"rewind",
	"task",
	"job",
	"irc",
	"todo",
	"web_search",
	"search_tool_bm25",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/**
 * First-party names accepted by the CLI `--tools` allowlist.
 * `generate_image` and `tts` are registered through the SDK custom-tool path,
 * not the `BUILTIN_TOOLS` factory map.
 */
export const CLI_TOOL_NAMES = [...BUILTIN_TOOL_NAMES, "generate_image", "tts"] as const;

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["search", "grep"],
	["find", "glob"],
]);

/** Return the canonical tool name for current and legacy built-in tool IDs. */
export function normalizeToolName(name: string): string {
	const normalized = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(normalized) ?? normalized;
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
