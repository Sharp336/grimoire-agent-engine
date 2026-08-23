import { describe, expect, test } from "bun:test";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import {
	isToolDisallowed,
	isToolScopedIn,
	sanitizeMCPToolNamePart,
} from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

// A raw config server name whose minted tool name exceeds the 64-char cap:
// `createMCPToolName` truncates the whole name and appends a hash suffix, so
// the `mcp__<server>_` prefix is no longer present in the registry key.
const LONG_SERVER_NAME = "very long server name that gets truncated at the 64 character cap boundary for testing";
const LONG_SERVER_PATTERN = `mcp__${sanitizeMCPToolNamePart(LONG_SERVER_NAME, "server")}_*`;
const CAPPED_MINTED_NAME = createMCPToolName(LONG_SERVER_NAME, "query_special_tool_name");

describe("isToolDisallowed", () => {
	test("matches all MCP tools with mcp__*", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__*"])).toBe(true);
		expect(isToolDisallowed("mcp__baz_qux", ["mcp__*"])).toBe(true);
	});

	test("matches one server with mcp__<server>_*", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_*"])).toBe(true);
		expect(isToolDisallowed("mcp__baz_qux", ["mcp__foo_*"])).toBe(false);
	});

	test("matches exact names without wildcard", () => {
		expect(isToolDisallowed("bash", ["bash"])).toBe(true);
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_bar"])).toBe(true);
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo"])).toBe(false);
	});

	test("does not match non-wildcard prefix against longer names", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo"])).toBe(false);
	});

	test("returns false for empty patterns", () => {
		expect(isToolDisallowed("bash", [])).toBe(false);
	});

	test("matches when any pattern matches", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["bash", "mcp__foo_*"])).toBe(true);
		expect(isToolDisallowed("bash", ["mcp__*", "bash"])).toBe(true);
	});

	test("never disallows hidden protocol tools", () => {
		expect(isToolDisallowed("yield", ["yield"])).toBe(false);
		expect(isToolDisallowed("yield", ["*"])).toBe(false);
		expect(isToolDisallowed("goal", ["goal"])).toBe(false);
		expect(isToolDisallowed("think", ["think"])).toBe(false);
	});

	test("capped minted names need mcpServerName metadata to match a server wildcard", () => {
		// Sanity: the fixture really is a capped name whose prefix no longer matches.
		expect(CAPPED_MINTED_NAME.length).toBe(64);
		expect(CAPPED_MINTED_NAME.startsWith(`mcp__${sanitizeMCPToolNamePart(LONG_SERVER_NAME, "server")}_`)).toBe(false);
		// Name-only: the truncated + hashed name misses the prefix match.
		expect(isToolDisallowed(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN])).toBe(false);
		// Ownership metadata (raw config server name) restores the one-server match.
		expect(isToolDisallowed(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN], LONG_SERVER_NAME)).toBe(true);
		// A different server's metadata does not match.
		expect(isToolDisallowed(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN], "other-server")).toBe(false);
		// Uncapped names still match by prefix regardless of metadata.
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__foo_*"], "irrelevant-server")).toBe(true);
	});

	test("mcpServerName metadata sanitizes the raw name against the pattern segment", () => {
		// `DB2` raw config name sanitizes to `db` (digits collapse into `_` and
		// trim away), exactly the prefix a `mcp__db_*` pattern names.
		expect(isToolDisallowed("mcp__db_query", ["mcp__db_*"], "DB2")).toBe(true);
		// The match is by sanitized server, not by tool name prefix: another
		// tool owned by the same raw server still matches.
		expect(isToolDisallowed("mcp__other_tool", ["mcp__db_*"], "DB2")).toBe(true);
		// A raw name with case/space differences sanitizes to the same segment.
		expect(isToolDisallowed("mcp__anything", ["mcp__foo_bar_*"], "Foo Bar")).toBe(true);
		// A pattern whose segment does not match the sanitized raw name stays inert.
		expect(isToolDisallowed("mcp__other_tool", ["mcp__db2_*"], "DB2")).toBe(false);
	});

	test("mcpServerName metadata never affects non-mcp patterns", () => {
		expect(isToolDisallowed("bash", ["b*"], "server-name")).toBe(true);
		expect(isToolDisallowed("read", ["b*"], "server-name")).toBe(false);
		expect(isToolDisallowed("bash", ["bash"], "server-name")).toBe(true);
		expect(isToolDisallowed("bash", ["read"], "server-name")).toBe(false);
	});

	test("mcp__* keeps matching every MCP tool regardless of metadata", () => {
		expect(isToolDisallowed("mcp__foo_bar", ["mcp__*"], "server-name")).toBe(true);
		expect(isToolDisallowed("bash", ["mcp__*"], "server-name")).toBe(false);
	});

	test("hidden protocol tools stay exempt even with mcpServerName metadata", () => {
		expect(isToolDisallowed("yield", ["*"], "server-name")).toBe(false);
		expect(isToolDisallowed("yield", ["mcp__*"], "server-name")).toBe(false);
		expect(isToolDisallowed("goal", [LONG_SERVER_PATTERN], LONG_SERVER_NAME)).toBe(false);
	});
});

describe("isToolScopedIn", () => {
	test("forwards mcpServerName metadata to the disallow check", () => {
		expect(isToolScopedIn(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN], {}, LONG_SERVER_NAME)).toBe(false);
		expect(isToolScopedIn(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN], {}, "other-server")).toBe(true);
		expect(isToolScopedIn(CAPPED_MINTED_NAME, [LONG_SERVER_PATTERN], {}, undefined)).toBe(true);
	});

	test("hidden protocol tools stay scoped in under an enforced allowlist with metadata", () => {
		expect(isToolScopedIn("yield", ["*"], { enforceToolAllowlist: true }, LONG_SERVER_NAME)).toBe(true);
	});
});
