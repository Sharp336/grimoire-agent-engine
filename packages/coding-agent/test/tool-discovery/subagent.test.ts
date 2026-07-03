import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	estimateMcpToolSchemaTokens,
	resolveEffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_AUTO_THRESHOLD,
	type ToolDiscoveryContextEstimate,
} from "@oh-my-pi/pi-coding-agent/tool-discovery/mode";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────

describe("effective discovery mode resolution", () => {
	function resolveEffectiveMode(
		settings: Settings,
		toolCount = 0,
		contextEstimate?: ToolDiscoveryContextEstimate,
	): "off" | "mcp-only" | "all" {
		return resolveEffectiveToolDiscoveryMode(settings, toolCount, contextEstimate);
	}

	it("tools.discoveryMode=all beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "all", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("tools.discoveryMode=mcp-only beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "mcp-only", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=true → mcp-only (back-compat alias)", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": true });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=false → off", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("off");
	});

	it("default auto settings stay off at the threshold", () => {
		const s = Settings.isolated({});
		expect(s.get("tools.discoveryMode")).toBe("auto");
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD)).toBe("off");
	});

	it("default auto settings enable mcp-only above the threshold", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD + 1)).toBe("mcp-only");
	});

	it("auto enables mcp-only when MCP schemas exceed the configured context share", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.5 });
		expect(resolveEffectiveMode(s, 1, { mcpSchemaTokens: 501, contextWindow: 1000 })).toBe("mcp-only");
	});

	it("auto count trigger remains active when context share is disabled", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0 });
		expect(
			resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD + 1, { mcpSchemaTokens: 0, contextWindow: 1000 }),
		).toBe("mcp-only");
	});

	it("zero discoveryContextShare disables the context-share trigger", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0 });
		expect(resolveEffectiveMode(s, 1, { mcpSchemaTokens: 501, contextWindow: 1000 })).toBe("off");
	});

	it("explicit all and mcp-only beat the context-share trigger", () => {
		const contextEstimate = { mcpSchemaTokens: 501, contextWindow: 1000 };
		expect(resolveEffectiveMode(Settings.isolated({ "tools.discoveryMode": "all" }), 1, contextEstimate)).toBe("all");
		expect(resolveEffectiveMode(Settings.isolated({ "tools.discoveryMode": "mcp-only" }), 1, contextEstimate)).toBe(
			"mcp-only",
		);
	});

	it("does not trigger context-share flip if contextWindow is zero", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.5 });
		expect(resolveEffectiveMode(s, 1, { mcpSchemaTokens: 501, contextWindow: 0 })).toBe("off");
	});
});

// ─── MCP schema-cost estimate tests ───────────────────────────────────────────
// Verify that the estimate includes the full tool definition (name, description,
// parameters), not just parameters — so large descriptions tip the threshold.
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateMcpToolSchemaTokens", () => {
	it("counts name and description, not just parameters", () => {
		const emptyParams = { type: "object", properties: {} };
		const minimal = estimateMcpToolSchemaTokens([{ name: "a", description: "", parameters: emptyParams }]);
		const withDescription = estimateMcpToolSchemaTokens([
			{ name: "a", description: "A".repeat(2000), parameters: emptyParams },
		]);
		expect(withDescription).toBeGreaterThan(minimal);
		// A 2000-char description should add a meaningful token count, not ~0.
		expect(withDescription - minimal).toBeGreaterThan(50);
	});

	it("large descriptions tip the estimate past the threshold even with tiny parameters", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.1 });
		const tinyParams = { type: "object", properties: {} };
		// A tool with a very large description but minimal parameters.
		const tools = [
			{
				name: "mcp__server__big_desc",
				description: "X".repeat(8000),
				parameters: tinyParams,
			},
		];
		const schemaTokens = estimateMcpToolSchemaTokens(tools);
		// With a 10_000-token context window and 0.1 share, the threshold is 1000.
		// The 8000-char description alone should exceed that.
		expect(schemaTokens).toBeGreaterThan(1000);
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: schemaTokens, contextWindow: 10_000 })).toBe(
			"mcp-only",
		);
		// The same tool with an empty description should stay well below.
		const emptyDescTokens = estimateMcpToolSchemaTokens([
			{ name: "mcp__server__big_desc", description: "", parameters: tinyParams },
		]);
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: emptyDescTokens, contextWindow: 10_000 })).toBe(
			"off",
		);
	});

	it("handles missing fields gracefully", () => {
		expect(estimateMcpToolSchemaTokens([{}])).toBeGreaterThanOrEqual(0);
		expect(estimateMcpToolSchemaTokens([])).toBe(0);
		// Undefined parameters should not throw.
		expect(estimateMcpToolSchemaTokens([{ name: "x", description: "y" }])).toBeGreaterThan(0);
	});

	it("does not serialize runtime-only fields", () => {
		// Tools may carry execute functions and other runtime fields that are
		// NOT part of the wire schema. The estimate should not be affected by them.
		const baseTokens = estimateMcpToolSchemaTokens([
			{ name: "a", description: "desc", parameters: { type: "object" } },
		]);
		const withRuntime = estimateMcpToolSchemaTokens([
			{
				name: "a",
				description: "desc",
				parameters: { type: "object" },
				// @ts-expect-error — runtime fields not in the type
				execute: () => {},
				label: "runtime label",
			},
		]);
		expect(withRuntime).toBe(baseTokens);
	});
});

// ─── Model-switch recomputation tests ────────────────────────────────────────
// Verify that the context-share threshold is re-evaluated when the context
// window changes (model switch), so MCP tools are hidden/exposed consistently.
// ─────────────────────────────────────────────────────────────────────────────

describe("model-switch discovery recomputation", () => {
	it("mode flips to mcp-only when switching to a smaller context window", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.5 });
		const schemaTokens = 600; // 600 tokens of MCP schema
		// Large context window: 600 < 0.5 * 10_000 = 5_000 → off
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: schemaTokens, contextWindow: 10_000 })).toBe(
			"off",
		);
		// Switch to small context window: 600 > 0.5 * 1_000 = 500 → mcp-only
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: schemaTokens, contextWindow: 1_000 })).toBe(
			"mcp-only",
		);
	});

	it("mode reverts to off when switching to a larger context window", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.5 });
		const schemaTokens = 600;
		// Small context: mcp-only
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: schemaTokens, contextWindow: 1_000 })).toBe(
			"mcp-only",
		);
		// Large context: off
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: schemaTokens, contextWindow: 10_000 })).toBe(
			"off",
		);
	});

	it("large descriptions cause mode flip on model switch even with tiny parameters", () => {
		const s = Settings.isolated({ "tools.discoveryContextShare": 0.1 });
		const tools = [
			{
				name: "mcp__server__verbose",
				description: "D".repeat(5000),
				parameters: { type: "object", properties: {} },
			},
		];
		const schemaTokens = estimateMcpToolSchemaTokens(tools);
		// Large context: below threshold → off
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: schemaTokens, contextWindow: 100_000 })).toBe(
			"off",
		);
		// Small context: above threshold → mcp-only
		expect(resolveEffectiveToolDiscoveryMode(s, 1, { mcpSchemaTokens: schemaTokens, contextWindow: 5_000 })).toBe(
			"mcp-only",
		);
	});
});
