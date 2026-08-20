import { describe, expect, it } from "bun:test";
import { normalizeToolName } from "../src/tools/builtin-names";

describe("normalizeToolName", () => {
	it("maps legacy builtin aliases without touching plugin case", () => {
		expect(normalizeToolName("search")).toBe("grep");
		expect(normalizeToolName("Read")).toBe("read");
		expect(normalizeToolName("CaseAdd")).toBe("CaseAdd");
		expect(normalizeToolName("Constructor")).toBe("Constructor");
	});
	it("lowercases an uppercase mcp__ prefix so promotion patterns match the minted name", () => {
		expect(normalizeToolName("MCP__Context_Resolve")).toBe("mcp__context_resolve");
		expect(normalizeToolName("mcp__db_query")).toBe("mcp__db_query");
	});
});
