import { describe, expect, it } from "bun:test";
import { normalizeToolName } from "../src/tools/builtin-names";

describe("normalizeToolName", () => {
	it("maps legacy builtin aliases without touching plugin case", () => {
		expect(normalizeToolName("search")).toBe("grep");
		expect(normalizeToolName("Read")).toBe("read");
		expect(normalizeToolName("CaseAdd")).toBe("CaseAdd");
		expect(normalizeToolName("Constructor")).toBe("Constructor");
	});
	it("leaves mcp__ names case-untouched for every caller", () => {
		// Shared semantics: only canonical builtins/legacy aliases fold case.
		// Uppercase mcp__ input is folded in the xdev promote path instead
		// (compileXdevPromoteSet), so tools:/--tools/advisor matching stays
		// byte-identical to upstream behavior.
		expect(normalizeToolName("MCP__Context_Resolve")).toBe("MCP__Context_Resolve");
		expect(normalizeToolName("mcp__db_query")).toBe("mcp__db_query");
	});
});
