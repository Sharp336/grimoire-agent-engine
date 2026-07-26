import { describe, expect, it } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import xdevMountNoticePrompt from "../src/prompts/system/xdev-mount-notice.md" with { type: "text" };

// Contract: `tools.xdevExternalDescriptionCap` controls how much of an
// EXTERNAL (dynamic-mount: MCP/custom/extension) device's description is
// embedded into the system prompt and catalog lines. Built-in devices are
// never capped, schemas are never capped, and `read xd://<tool>` (docs())
// always returns the full text regardless of the cap.

const LONG_DESCRIPTION = `gitnexus-style tool. ${"x".repeat(400)}`;

function fakeTool(name: string, description: string): Tool {
	return {
		name,
		label: name,
		description,
		parameters: type({}),
		execute: async () => ({ content: [] }),
	} as unknown as Tool;
}

const builtin = fakeTool("ast_grep", "Structural code search via ast-grep.");
const dynamic = fakeTool("mcp__gateway_gitnexus_search_code_flows", LONG_DESCRIPTION);

function makeRegistry(cap?: number): XdevRegistry {
	const registry = cap === undefined ? new XdevRegistry([builtin]) : new XdevRegistry([builtin], cap);
	registry.reconcile([dynamic]);
	return registry;
}

describe("XdevRegistry external description cap", () => {
	it("truncates dynamic descriptions to the custom cap in entries and docsAll", () => {
		const registry = makeRegistry(50);

		const entries = registry.entries();
		const dynamicEntry = entries.find(entry => entry.name === dynamic.name);
		const builtinEntry = entries.find(entry => entry.name === builtin.name);
		expect(dynamicEntry).toBeDefined();
		expect(dynamicEntry!.summary.length).toBeLessThanOrEqual(51); // 50 + ellipsis
		// Built-ins are never capped.
		expect(builtinEntry!.summary).toBe(builtin.description);

		const docs = registry.docsAll("inline");
		expect(docs).toContain("… (full docs: read xd://");
		expect(docs).not.toContain(LONG_DESCRIPTION);
		// The schema survives truncation intact.
		expect(docs).toContain('"type": "object"');
	});

	it("keeps the 200-char default when no cap is given", () => {
		const registry = makeRegistry();
		const docs = registry.docsAll("inline");
		expect(docs).not.toContain(LONG_DESCRIPTION);
		expect(docs).toContain("… (full docs: read xd://");
	});

	it("embeds the full description when the cap exceeds its length", () => {
		const registry = makeRegistry(10_000);
		expect(registry.docsAll("inline")).toContain(LONG_DESCRIPTION);
	});

	it("applies setExternalDescriptionCap live", () => {
		const registry = makeRegistry(50);
		expect(registry.docsAll("inline")).not.toContain(LONG_DESCRIPTION);
		registry.setExternalDescriptionCap(10_000);
		expect(registry.docsAll("inline")).toContain(LONG_DESCRIPTION);
	});

	it("never truncates single-device docs (read xd://<tool>)", () => {
		const registry = makeRegistry(50);
		expect(registry.docs(dynamic.name)).toContain(LONG_DESCRIPTION);
	});

	it("caps docsFor the same way as docsAll", () => {
		const registry = makeRegistry(50);
		const docs = registry.docsFor([dynamic.name], "inline");
		expect(docs).not.toContain(LONG_DESCRIPTION);
		expect(docs).toContain("… (full docs: read xd://");
	});

	it("keeps the complete catalog within the aggregate docs budget", () => {
		const registry = new XdevRegistry([], 4000);
		registry.reconcile(
			Array.from({ length: 150 }, (_, index) =>
				fakeTool(`mcp__large_catalog_tool_${index}`, `Tool ${index}. ${"x".repeat(5000)}`),
			),
		);

		const docs = registry.docsAll("catalog");
		expect(docs.length).toBeLessThanOrEqual(XdevRegistry.DOCS_TOTAL_BUDGET);
		expect(docs).toContain("## Additional devices (docs on demand)");
		expect(docs).toContain("- xd://mcp__large_catalog_tool_0 —");
		expect(docs).not.toContain("- xd://mcp__large_catalog_tool_149 —");
		expect(docs).toMatch(/- \d+ more devices omitted — read xd:\/\/ for the complete inventory\./);
	});

	it("bounds the rendered mount notice under the aggregate docs budget", () => {
		const registry = new XdevRegistry([], 4000);
		const tools = Array.from({ length: 150 }, (_, index) =>
			fakeTool(`mcp__large_catalog_tool_${index}`, `Tool ${index}. ${"x".repeat(5000)}`),
		);
		registry.reconcile(tools);
		const names = tools.map(tool => tool.name);

		const inventory = registry.mountNoticeEntries(names);
		// Shared budget: inline docs get only what the inventory did not spend.
		const docsBudget = Math.max(0, XdevRegistry.DOCS_TOTAL_BUDGET - inventory.usedChars);
		const docs = registry.docsFor(names, "inline", [], docsBudget);
		// Render the actual mount-notice template exactly as
		// `SessionTools.takePendingXdevMountNotice()` does — the budget contract
		// covers the provider-visible message, not a hand-built approximation.
		const content = prompt.render(xdevMountNoticePrompt, {
			added: inventory.entries,
			removed: [],
			docs,
			omitted_line: inventory.omittedLine || undefined,
		});

		// The fixed template boilerplate is not budgeted; measure it by rendering
		// the same branches with 1-char markers and subtracting the marker bytes.
		const marker = prompt.render(xdevMountNoticePrompt, {
			added: [{ name: "n", summary: "s" }],
			removed: [],
			docs: "d",
			omitted_line: undefined,
		});
		const overhead = marker.length - "- xd://n — s".length - "d".length;
		expect(content.length).toBeLessThanOrEqual(XdevRegistry.DOCS_TOTAL_BUDGET + overhead);
		// Rows whose summary was budgeted away must not emit an unbudgeted ` — `.
		expect(content).not.toMatch(/—\s*\n/);

		// Name slots are reserved first: every mounted tool is announced even
		// when the high per-device cap would otherwise exhaust the budget early.
		expect(inventory.entries.length).toBe(150);
		expect(inventory.omitted).toBe(0);
		expect(inventory.entries[0]?.name).toBe("mcp__large_catalog_tool_0");
		expect(inventory.entries[149]?.name).toBe("mcp__large_catalog_tool_149");
		expect(content).toContain("- xd://mcp__large_catalog_tool_149");
		// First tools keep some summary lede; later rows shrink rather than
		// emitting uncapped 4000-char descriptions for every device.
		expect(inventory.entries[0]?.summary.length ?? 0).toBeGreaterThan(0);
		expect(inventory.entries.some(row => row.summary.length < 4000)).toBe(true);
	});

	it("announces devices omitted when name-only rows exhaust the budget", () => {
		const registry = new XdevRegistry([], 0);
		// Pathologically long names so name-only bullets exceed a tiny budget.
		const tools = Array.from({ length: 20 }, (_, index) =>
			fakeTool(`mcp__${"x".repeat(200)}_${index}`, `Tool ${index}`),
		);
		registry.reconcile(tools);
		const tinyBudget = 800;
		const inventory = registry.mountNoticeEntries(
			tools.map(tool => tool.name),
			tinyBudget,
		);
		expect(inventory.entries.length).toBeGreaterThan(0);
		expect(inventory.omitted).toBeGreaterThan(0);
		expect(inventory.omittedLine).toMatch(/more devices omitted — read xd:\/\//);
		expect(inventory.usedChars).toBeLessThanOrEqual(tinyBudget);
		expect(inventory.entries.length + inventory.omitted).toBe(20);
		// The rendered notice carries the omitted count and the `read xd://`
		// inventory pointer so unlisted devices stay discoverable.
		const content = prompt.render(xdevMountNoticePrompt, {
			added: inventory.entries,
			removed: [],
			docs: "",
			omitted_line: inventory.omittedLine || undefined,
		});
		expect(content).toContain(`${inventory.omitted} more devices omitted — read xd:// for the complete inventory.`);
	});
});
