import { describe, expect, it } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { type } from "arktype";

// Contract: `tools.xdevDocsMaxPercent` expresses the total inlined-docs budget
// as a percent of the model's context window instead of the fixed 48k-char
// default. 0 (or an unknown window) preserves the built-in budget; devices
// past the resolved budget degrade to catalog lines (docs stay on demand).
function fakeTool(name: string, description: string): Tool {
	return {
		name,
		label: name,
		description,
		parameters: type({}),
		execute: async () => ({ content: [] }),
	} as unknown as Tool;
}

describe("XdevRegistry.resolveDocsTotalBudget", () => {
	it("returns the built-in default when percent is 0 or the window is unknown", () => {
		expect(XdevRegistry.resolveDocsTotalBudget(0, 272_000)).toBe(XdevRegistry.DOCS_TOTAL_BUDGET);
		expect(XdevRegistry.resolveDocsTotalBudget(10, undefined)).toBe(XdevRegistry.DOCS_TOTAL_BUDGET);
		expect(XdevRegistry.resolveDocsTotalBudget(10, 0)).toBe(XdevRegistry.DOCS_TOTAL_BUDGET);
	});

	it("converts percent of context window at ~4 chars/token", () => {
		// 10% of 272k tokens = 27.2k tokens = 108,800 chars
		expect(XdevRegistry.resolveDocsTotalBudget(10, 272_000)).toBe(108_800);
		// 10% of 64k tokens = 6.4k tokens = 25,600 chars (tighter than default)
		expect(XdevRegistry.resolveDocsTotalBudget(10, 64_000)).toBe(25_600);
	});

	it("clamps percent above 100", () => {
		expect(XdevRegistry.resolveDocsTotalBudget(150, 100_000)).toBe(400_000);
	});
});

describe("docsAll with an explicit total budget", () => {
	// Multi-line descriptions: the catalog summary is only the first line, so
	// the padded second line appears ONLY when the full docs are inlined.
	const bigBuiltin = fakeTool("ast_grep", `Built-in docs.\n${"y".repeat(2000)}`);
	const anotherBuiltin = fakeTool("lsp", `More built-in docs.\n${"z".repeat(2000)}`);

	it("overflows devices past the budget into the catalog section", () => {
		const registry = new XdevRegistry([bigBuiltin, anotherBuiltin]);
		const full = registry.docsAll("builtins");
		expect(full).toContain("y".repeat(2000));
		expect(full).toContain("z".repeat(2000));

		// Budget that fits only one device: the second degrades to a catalog
		// line under "Additional devices".
		const tight = registry.docsAll("builtins", [], 3000);
		const inlined = ["y".repeat(2000), "z".repeat(2000)].filter(marker => tight.includes(marker));
		expect(inlined.length).toBe(1);
		expect(tight).toContain("Additional devices (docs on demand)");
	});

	it("docsFor respects the explicit budget as well", () => {
		const registry = new XdevRegistry([bigBuiltin, anotherBuiltin]);
		const docs = registry.docsFor([bigBuiltin.name, anotherBuiltin.name], "builtins", [], 100);
		expect(docs).toBe("");
	});
});
