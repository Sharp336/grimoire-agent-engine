import { describe, expect, test } from "bun:test";
import { isToolDisallowed } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";

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
});
